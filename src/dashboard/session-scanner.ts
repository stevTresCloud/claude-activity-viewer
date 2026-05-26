/* ================================================================
 * session-scanner.ts — Descubre sesiones históricas de Claude Code.
 *
 * Lee `~/.claude/projects/<encoded-cwd>/*.jsonl`. Cada `*.jsonl` es
 * una sesión histórica (interactiva o programática) que Steven (o
 * cualquier otro entrypoint) abrió alguna vez en su máquina. Cada
 * sesión guarda en el header el cwd absoluto + sessionId + branch
 * + entrypoint + timestamps.
 *
 * Stateless por diseño igual que el project scanner — cada
 * `scanSessions` re-lee todo el árbol. El cap por subfolder + el
 * parse line-by-line mantienen el costo manejable (262 sesiones en
 * la máquina de Steven al momento de la implementación).
 *
 * Parser TOLERANTE:
 *   - Líneas malformadas → skip + log al OutputChannel (no tira).
 *   - Archivos truncados → leemos hasta donde se pueda.
 *   - JSONL sin `cwd`+`sessionId` → skip.
 *   - Las primeras líneas suelen ser `{type:"queue-operation"}` sin
 *     `cwd`; el parser sigue hasta encontrar la primera con el
 *     shape correcto.
 *
 * El cwd autoritativo viene del campo `cwd` interno del JSONL (no
 * del nombre de carpeta encoded). El nombre encoded NO es bijection
 * cuando el path original contiene `-` (ej. `claude-orchestrator`).
 * ================================================================ */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type {
  ProjectFromDisk,
  SessionFromDisk,
} from '../shared/dashboard-protocol';
import type { ScannerLogger } from './project-scanner';

// === Constantes ===

/**
 * Tope de sesiones a parsear por subfolder (~/.claude/projects/<cwd-encoded>).
 * Si el folder tiene más, ordenamos por mtime descendente y nos
 * quedamos con las más recientes — son las que el user querría
 * retomar. El resto se loggea como `truncated=N`.
 */
const MAX_SESSIONS_PER_FOLDER = 100;

/**
 * Tope de bytes parseados por archivo `.jsonl`. Los archivos
 * pueden traer base64 de screenshots inline (cientos de KB por
 * mensaje); con 100 archivos × 5MB el scan inicial supera los
 * 500MB de I/O y se siente como freeze. Cortamos el stream una
 * vez que crucemos este tope; el último JSON parseable que vimos
 * gana para inferir status. Suficiente para la UX (los primeros
 * eventos importan más: cwd, primer prompt, branch).
 */
const MAX_BYTES_PER_FILE = 256 * 1024;

/** Lo que mostramos en la UI como primer prompt — versión compacta (1 línea). */
const FIRST_PROMPT_MAX_CHARS = 80;
/**
 * Versión larga del primer prompt — visible cuando el user
 * expande la card. 400 chars cubre ~5-6 líneas de texto razonable;
 * más allá la card se vuelve un wall of text.
 */
const FIRST_PROMPT_FULL_MAX_CHARS = 400;

/**
 * Sessions IDs válidos son UUIDs/hex con guiones (la convención que
 * usa Claude Code). Validamos en el parser para que un JSONL
 * adversario o corrupto no pueda inyectar caracteres shell-mágicos
 * cuando el controller construya `claude --resume <sessionId>` en
 * una terminal. Anchor a ^$ en el matcher.
 */
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// === Tipos del JSONL (subset que parseamos) ===

/**
 * Shape mínimo de una línea de header (la primera línea con
 * sessionId + cwd + entrypoint). El resto de campos los ignoramos
 * porque no aportan al scanner.
 *
 * `message.content` puede ser string o array de blocks (text /
 * image / tool_use). Nuestro objetivo es sacar texto del primer
 * `type:user` para mostrar como prompt.
 */
interface JsonlHeaderLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/** Shape del último evento que nos interesa para inferir status. */
interface JsonlTerminalLine {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  timestamp?: string;
}

// ====================================================================
// === API pública ====================================================
// ====================================================================

/**
 * Entrada cacheada en el índice persistente. Es la SessionFromDisk
 * + mtime del archivo. La key del Map externo es el `filePath`
 * absoluto del .jsonl. Si la mtime del file en disco coincide con
 * la cacheada, podemos reusar el entry sin re-parsear el JSONL.
 */
export interface CachedSession {
  session: SessionFromDisk;
  mtimeMs: number;
}

/**
 * Resultado del scan: sesiones + cache actualizado + stats.
 * El caller persiste `nextCache` y se lo vuelve a pasar en la
 * siguiente invocación. `stats` reporta cuántos hits del cache
 * hubo para loggear al OutputChannel.
 */
export interface ScanSessionsResult {
  sessions: SessionFromDisk[];
  nextCache: Map<string, CachedSession>;
  stats: {
    reusedFromCache: number;
    reparsed: number;
    cleanedUp: number;
  };
}

export interface ScanSessionsOptions {
  /** Path absoluto al root de Claude (típicamente `~/.claude/projects`). */
  claudeProjectsDir: string;
  /**
   * Roots configurados por el user (`claudeOrchestrator.projectsRoot`)
   * para derivar project/task con la misma lógica que los agentes
   * vivos.
   */
  projectsRoot: string[];
  /**
   * Función de derivación project/task. Recibe el cwd autoritativo
   * del JSONL + el primer prompt user (opcional) y devuelve
   * `{project, task}`. El prompt habilita la heurística de path-
   * matching cuando el cwd genérico no nos da info útil.
   *
   * Inyectada (no importada) para que los tests usen una versión
   * pura sin levantar `vscode`. En runtime se pasa la del bridge.
   */
  deriveContext: (
    cwd: string,
    projectsRoot: string[],
    firstUserPrompt?: string,
    signalText?: string,
  ) => { project: string; task: string };
  /**
   * Cache previo del scan anterior. Si el archivo en disco tiene
   * la misma mtime que la entry cacheada, se reusa sin re-parsear.
   * Pasar Map vacío o undefined fuerza re-parseo completo.
   */
  cache?: Map<string, CachedSession>;
  logger?: ScannerLogger;
}

/**
 * Lee todo el árbol de `~/.claude/projects/` y devuelve un
 * SessionFromDisk por cada `*.jsonl` parseable.
 *
 * Errores silenciosos: subfolder o file que no se puede abrir →
 * skip + log. La UI prefiere lista parcial.
 *
 * Optimizado con cache incremental: si se pasa `cache` y la mtime
 * del archivo coincide con la entry cacheada, se reusa sin
 * re-parsear. En el caso típico (0-2 archivos modificados) el
 * scan pasa de ~10s a ~300ms.
 */
export async function scanSessions(
  options: ScanSessionsOptions,
): Promise<ScanSessionsResult> {
  const root = path.resolve(options.claudeProjectsDir);
  const cache = options.cache ?? new Map<string, CachedSession>();
  let subfolders: string[];
  try {
    const dirents = await fs.promises.readdir(root, { withFileTypes: true });
    subfolders = dirents
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    options.logger?.appendLine(
      `[scanner] cannot read claude projects dir "${root}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      sessions: [],
      nextCache: new Map(),
      stats: { reusedFromCache: 0, reparsed: 0, cleanedUp: cache.size },
    };
  }

  // === Recolectar paths *.jsonl con su mtime para ordenar ===
  // Procesamos folder por folder para aplicar el cap por folder.
  const sessions: SessionFromDisk[] = [];
  const seenSessionIds = new Set<string>();
  const nextCache = new Map<string, CachedSession>();
  let reusedFromCache = 0;
  let reparsed = 0;

  for (const folder of subfolders) {
    const folderPath = path.join(root, folder);
    let jsonlEntries: { file: string; mtimeMs: number }[];
    try {
      const dirents = await fs.promises.readdir(folderPath, {
        withFileTypes: true,
      });
      const candidates = dirents
        .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
        .map((d) => path.join(folderPath, d.name));
      const stats = await Promise.allSettled(
        candidates.map(async (file) => ({
          file,
          mtimeMs: (await fs.promises.stat(file)).mtimeMs,
        })),
      );
      jsonlEntries = stats
        .filter(
          (s): s is PromiseFulfilledResult<{ file: string; mtimeMs: number }> =>
            s.status === 'fulfilled',
        )
        .map((s) => s.value);
    } catch (err) {
      options.logger?.appendLine(
        `[scanner] cannot read folder "${folderPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    // === Cap por folder ===
    // Sort por mtime descendente (más recientes primero) y tomar
    // los N más recientes — son las sesiones que el user
    // querría retomar.
    jsonlEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const truncated = Math.max(0, jsonlEntries.length - MAX_SESSIONS_PER_FOLDER);
    if (truncated > 0) {
      options.logger?.appendLine(
        `[scanner] folder "${folder}" has ${jsonlEntries.length} sessions; parsing ${MAX_SESSIONS_PER_FOLDER} most recent (truncated=${truncated}).`,
      );
    }
    const capped = jsonlEntries.slice(0, MAX_SESSIONS_PER_FOLDER);

    // === Cache lookup por archivo ===
    // Separamos los entries en (a) hits del cache cuya mtime coincide
    // — reusamos sin parsear, y (b) misses — los pasamos al parser.
    // Esto baja el costo del scan de O(N archivos × parse) a
    // O(N stats + M re-parsea) donde M suele ser 0-2 en uso normal.
    const toReparse: { file: string; mtimeMs: number }[] = [];
    for (const entry of capped) {
      const cached = cache.get(entry.file);
      if (cached && cached.mtimeMs === entry.mtimeMs) {
        // Hit: reusamos el SessionFromDisk del cache + lo movemos
        // al nextCache para que persista en el próximo scan.
        const session = cached.session;
        if (seenSessionIds.has(session.sessionId)) continue;
        seenSessionIds.add(session.sessionId);
        sessions.push(session);
        nextCache.set(entry.file, cached);
        reusedFromCache++;
      } else {
        toReparse.push(entry);
      }
    }

    // === Parsear los misses en paralelo ===
    const parsed = await Promise.allSettled(
      toReparse.map((entry) =>
        parseSessionFile(
          entry.file,
          options.projectsRoot,
          options.deriveContext,
          options.logger,
        ),
      ),
    );

    for (let i = 0; i < parsed.length; i++) {
      const r = parsed[i];
      const entry = toReparse[i];
      if (r.status !== 'fulfilled' || r.value === null) continue;
      const session = r.value;
      // Dedup por sessionId: si el mismo session id aparece en dos
      // subfolders (no debería, pero por las dudas), nos quedamos
      // con la primera entrada que llega.
      if (seenSessionIds.has(session.sessionId)) continue;
      seenSessionIds.add(session.sessionId);
      sessions.push(session);
      // Solo cacheamos resultados FRESCOS — un parser que devolvió
      // null (file inválido) no entra al cache para que el próximo
      // scan vuelva a intentar (puede haber sido un .jsonl en
      // proceso de escritura cuando hicimos stat).
      nextCache.set(entry.file, { session, mtimeMs: entry.mtimeMs });
      reparsed++;
    }
  }

  // === Stats finales: cuántos archivos del cache previo quedaron
  // huérfanos (archivo borrado de disco). Los descartamos
  // implícitamente al construir nextCache solo con files vistos. ===
  const cleanedUp = Math.max(0, cache.size - nextCache.size);

  // Ordenamos global por endedAtIso descendente para que la UI
  // pueda mostrarlos directo "más reciente primero". Sesiones sin
  // timestamp parseable (endedAtIso vacío) van al final, no
  // mezcladas: localeCompare con string vacío deja orden indefinido,
  // así que filtramos explícito.
  sessions.sort((a, b) => {
    if (!a.endedAtIso && !b.endedAtIso) return 0;
    if (!a.endedAtIso) return 1;
    if (!b.endedAtIso) return -1;
    return b.endedAtIso.localeCompare(a.endedAtIso);
  });
  return {
    sessions,
    nextCache,
    stats: { reusedFromCache, reparsed, cleanedUp },
  };
}

// ====================================================================
// === Parser de un JSONL =============================================
// ====================================================================

/**
 * Parsea un archivo `.jsonl` y devuelve un SessionFromDisk o null
 * si no se puede sacar al menos cwd+sessionId.
 *
 * Estrategia: leer line-by-line con readline (no readFileSync —
 * algunos `.jsonl` traen base64 de screenshots y crecen rápido).
 *   1. Avanzar hasta encontrar la primera línea con cwd+sessionId.
 *      Esa es la "header line" — saca cwd, sessionId, entrypoint,
 *      gitBranch, startedAtIso.
 *   2. Si esa línea es `type:"user"`, sacar primer prompt del
 *      `message.content` (limpiando bloques `<ide_*>...</ide_*>`).
 *   3. Seguir leyendo para capturar el último timestamp y el shape
 *      del último evento (para inferir status: done/failed/interrupted).
 *
 * Toleramos:
 *   - Líneas no-JSON → skip + bump counter.
 *   - Líneas sin `type` → skip.
 *   - File truncado a mitad → último parse válido gana.
 */
async function parseSessionFile(
  filePath: string,
  projectsRoot: string[],
  deriveContext: (
    cwd: string,
    projectsRoot: string[],
    firstUserPrompt?: string,
    signalText?: string,
  ) => { project: string; task: string },
  logger?: ScannerLogger,
): Promise<SessionFromDisk | null> {
  let header: JsonlHeaderLine | null = null;
  let firstUserPrompt: string | null = null;
  // Texto adicional para la heurística de project: acumula
  // mensajes user (más allá del primero) + file_paths de tool_use.
  // Esto captura sesiones cuyo primer prompt no menciona el path
  // pero los siguientes turnos sí (caso "Continuamos con la
  // tarea X" donde el primer mensaje fue conversacional y los
  // tool_use sí tocaron el path real).
  const signalChunks: string[] = [];
  let userPromptsCaptured = 0;
  let toolUsePathsCaptured = 0;
  const MAX_USER_PROMPTS_FOR_SIGNAL = 5;
  const MAX_TOOL_USE_PATHS_FOR_SIGNAL = 20;
  let lastTerminal: JsonlTerminalLine | null = null;
  let lastTimestamp: string | null = null;
  let skipCount = 0;

  let bytesRead = 0;
  let truncated = false;

  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    for await (const rawLine of rl) {
      // Bytes aproximados: utf-8 length de la línea + 1 (newline).
      // No hace falta exactitud — el tope es una guardia de UX,
      // no un contrato.
      bytesRead += rawLine.length + 1;
      if (bytesRead > MAX_BYTES_PER_FILE) {
        truncated = true;
        // Cerramos el stream antes de salir del for-await para
        // soltar el file descriptor inmediato.
        rl.close();
        stream.destroy();
        break;
      }
      const line = rawLine.trim();
      if (!line) continue;
      let parsed: JsonlHeaderLine & JsonlTerminalLine;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipCount++;
        continue;
      }

      // Header: primera línea con cwd+sessionId.
      if (!header && parsed.cwd && parsed.sessionId) {
        header = parsed;
      }

      // Primer prompt user: lo capturamos del mismo evento o del
      // primer `type:"user"` posterior. `message.content` puede ser
      // string o array de blocks; los `<ide_*>` los limpiamos.
      // Acumulamos hasta MAX_USER_PROMPTS_FOR_SIGNAL prompts en
      // signalChunks para que la heurística de project pueda buscar
      // paths en cualquiera de ellos, no solo el primero.
      if (
        parsed.type === 'user' &&
        parsed.message &&
        userPromptsCaptured < MAX_USER_PROMPTS_FOR_SIGNAL
      ) {
        const text = extractUserText(parsed.message.content);
        if (text) {
          if (firstUserPrompt === null) {
            firstUserPrompt = text;
          }
          // Para el signal usamos el texto crudo (sin truncar ni
          // limpiar) — los paths absolutos en mensajes posteriores
          // pueden estar fuera de los primeros 80 chars.
          signalChunks.push(text);
          userPromptsCaptured++;
        }
      }

      // tool_use: capturamos file_path / path / notebook_path como
      // señal adicional. Es la fuente MÁS fuerte (cuando Claude lee
      // un archivo del proyecto el path es siempre absoluto y real).
      if (
        parsed.type === 'assistant' &&
        toolUsePathsCaptured < MAX_TOOL_USE_PATHS_FOR_SIGNAL
      ) {
        const paths = extractToolUsePaths(parsed.message?.content);
        for (const p of paths) {
          signalChunks.push(p);
          toolUsePathsCaptured++;
          if (toolUsePathsCaptured >= MAX_TOOL_USE_PATHS_FOR_SIGNAL) break;
        }
      }

      if (parsed.timestamp) {
        lastTimestamp = parsed.timestamp;
      }
      // Eventos terminales que nos interesan para inferir status.
      if (parsed.type === 'result') {
        lastTerminal = parsed;
      }
    }

    if (skipCount > 10) {
      logger?.appendLine(
        `[scanner] file "${path.basename(filePath)}" had ${skipCount} unparseable lines (likely corrupted).`,
      );
    }
    if (truncated) {
      logger?.appendLine(
        `[scanner] file "${path.basename(filePath)}" truncated at ${MAX_BYTES_PER_FILE} bytes; status may be approximate.`,
      );
    }
  } catch (err) {
    logger?.appendLine(
      `[scanner] read failure on "${path.basename(filePath)}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  if (!header || !header.cwd || !header.sessionId) {
    return null;
  }

  // === Validación de sessionId ===
  // El sessionId se concatena luego a `claude --resume <id>` en una
  // terminal. Aunque el JSONL sea propio del user, un archivo
  // tampered o un bug del SDK podría poner caracteres shell-mágicos.
  // Si no matchea UUID-canónico, descartamos la sesión (es más
  // probable que sea corrupción que un id válido).
  if (!SESSION_ID_PATTERN.test(header.sessionId)) {
    logger?.appendLine(
      `[scanner] file "${path.basename(filePath)}" has unexpected sessionId shape; skipping.`,
    );
    return null;
  }

  const startedAtIso = header.timestamp ?? lastTimestamp ?? '';
  const endedAtIso = lastTimestamp ?? startedAtIso;
  const status = inferStatus(lastTerminal);
  // Pasamos el firstPrompt LIMPIO (ya sin tags ide_*) para que la
  // heurística de derivePathFromPrompt no se confunda con paths
  // que vinieron del <ide_selection> de VS Code (que típicamente
  // refleja el archivo que el user tenía abierto, no la tarea).
  // El `signalText` adicional concatena los siguientes prompts user
  // + paths absolutos de tool_use — fuente más fuerte que el primer
  // prompt en sesiones que arrancan conversacionales.
  const signalText = signalChunks.length > 0 ? signalChunks.join('\n') : undefined;
  const ctx = deriveContext(
    header.cwd,
    projectsRoot,
    firstUserPrompt ?? undefined,
    signalText,
  );

  // gitBranch puede venir con whitespace ("main\n") o ser "HEAD" en
  // detached state. Trim primero para que la comparación HEAD no
  // falle, y dejamos string vacío en ambos casos (criterio igual al
  // project scanner).
  const branchRaw = (header.gitBranch ?? '').trim();
  const branch = branchRaw === 'HEAD' ? '' : branchRaw;

  // Limpieza + dos truncados: corto (80) para la lista compacta,
  // largo (400) para cuando el user expande la card.
  const rawPrompt = firstUserPrompt ?? '';
  const promptShort = rawPrompt ? cleanFirstPrompt(rawPrompt, FIRST_PROMPT_MAX_CHARS) : '';
  const promptFull = rawPrompt ? cleanFirstPrompt(rawPrompt, FIRST_PROMPT_FULL_MAX_CHARS) : '';

  return {
    filePath,
    sessionId: header.sessionId,
    cwd: header.cwd,
    project: ctx.project,
    task: ctx.task,
    branch,
    firstPrompt: promptShort || '(no prompt)',
    firstPromptFull: promptFull || '(no prompt)',
    startedAtIso,
    endedAtIso,
    status,
    entrypoint: header.entrypoint ?? 'unknown',
  };
}

// ====================================================================
// === Helpers de parsing =============================================
// ====================================================================

/**
 * Extrae texto plano del campo `message.content` de un evento user.
 * `content` puede ser:
 *   - string (raro, viejos JSONL).
 *   - Array de blocks `{type:"text", text:"..."}`, `{type:"image", ...}`,
 *     `{type:"tool_use", ...}`. Concatenamos solo los `type:"text"`.
 *
 * Devuelve null si no encontramos texto.
 */
export function extractUserText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      (block as { type: unknown }).type === 'text' &&
      'text' in block &&
      typeof (block as { text: unknown }).text === 'string'
    ) {
      texts.push((block as { text: string }).text);
    }
  }
  return texts.length > 0 ? texts.join(' ') : null;
}

/**
 * Limpia un texto user para mostrarlo como "primer prompt":
 *   1. Remueve bloques `<ide_selection>...</ide_selection>`,
 *      `<ide_opened_file>...</ide_opened_file>` y similares — son
 *      contexto agregado por la integración VS Code, no la
 *      intención del user.
 *   2. Colapsa whitespace a un solo espacio.
 *   3. Trunca a `maxChars` con elipsis si excede.
 *
 * Si tras la limpieza queda vacío, devuelve cadena vacía (el
 * caller usa fallback "(no prompt)"). El default keeps backward
 * compat con call sites antiguos que esperaban 80 chars.
 */
export function cleanFirstPrompt(
  text: string,
  maxChars: number = FIRST_PROMPT_MAX_CHARS,
): string {
  const stripped = text.replace(/<ide_[^>]+>[\s\S]*?<\/ide_[^>]+>/g, '');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '';
  if (collapsed.length <= maxChars) return collapsed;
  return collapsed.slice(0, maxChars - 1) + '…';
}

/**
 * Infiere status del último evento del JSONL.
 *
 *   - `type:"result"` + `subtype:"success"` → done.
 *   - `type:"result"` + `is_error:true` → failed.
 *   - `type:"result"` + cualquier otro subtype → failed (timeout,
 *     max_turns, etc.).
 *   - Sin terminal → interrupted (el user cerró el IDE o mató el
 *     proceso antes del result).
 */
export function inferStatus(
  last: JsonlTerminalLine | null,
): SessionFromDisk['status'] {
  if (!last || last.type !== 'result') return 'interrupted';
  if (last.is_error === true) return 'failed';
  if (last.subtype === 'success') return 'done';
  return 'failed';
}

/**
 * Extrae paths (absolutos o relativos) de los bloques tool_use de
 * un mensaje assistant. Mira las keys comunes que tools como
 * Read/Edit/Write/Bash/Glob usan para indicar archivos:
 *   - file_path / path / notebook_path → directos.
 *   - command → bash con paths embebidos.
 *
 * Devuelve hasta 3 paths por bloque para no inflar el signalText.
 * Exportada para tests.
 */
export function extractToolUsePaths(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'command'];
  for (const block of content) {
    if (
      !block ||
      typeof block !== 'object' ||
      (block as { type?: unknown }).type !== 'tool_use'
    ) {
      continue;
    }
    const input = (block as { input?: unknown }).input;
    if (!input || typeof input !== 'object') continue;
    const obj = input as Record<string, unknown>;
    let foundForBlock = 0;
    for (const key of PATH_KEYS) {
      if (foundForBlock >= 3) break;
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) {
        out.push(v);
        foundForBlock++;
      }
    }
  }
  return out;
}

/**
 * Filtra sesiones contra los proyectos descubiertos en disco: si
 * el cwd de la sesión cae dentro de algún ProjectFromDisk.path, la
 * sesión es relevante para el dropdown del selector.
 *
 * Exportada para tests + uso futuro del store (la UI puede querer
 * mostrar el botón "scan all" para ver sesiones huérfanas).
 */
export function sessionsInProjects(
  sessions: SessionFromDisk[],
  projects: ProjectFromDisk[],
): SessionFromDisk[] {
  if (projects.length === 0) return sessions;
  const roots = projects.map((p) => p.path);
  return sessions.filter((s) => {
    const cwd = path.resolve(s.cwd);
    return roots.some((root) => cwd === root || cwd.startsWith(root + path.sep));
  });
}
