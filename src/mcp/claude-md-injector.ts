// === CLAUDE.md workspace injector ===
//
// Inserta (o actualiza) una sección demarcada con tags HTML-comment en
// los CLAUDE.md de los workspaces configurados en
// `claudeOrchestrator.projectsRoot`. Sin esto, el chat caller invoca
// `spawn_agents` solo ~80% del tiempo (depende de la heurística del
// modelo y del ~/.claude/CLAUDE.md user-level). Con la sección embebida
// en el CLAUDE.md del workspace activo, el modelo lo lee como contexto
// del proyecto y la elección se vuelve determinista.
//
// Decisiones:
//   - SOLO escribe si el CLAUDE.md ya existe en el subdirectorio
//     (modo auto). El comando palette manual SÍ crea el archivo si
//     el user pide explícitamente.
//   - Sección demarcada con `<!-- claude-orchestrator:start -->` ...
//     `<!-- claude-orchestrator:end -->`. Si los tags existen, reemplaza
//     solo el contenido entre ellos (preserva todo lo demás).
//   - Atomic write via tmp + rename para que un crash mid-write no
//     deje el archivo corrupto.
//   - Skipea silenciosamente si el contenido ya está actualizado (no
//     reescribe en cada activate).
//   - Idempotente: correr 100 veces seguidas produce el mismo archivo.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const START_TAG = '<!-- claude-orchestrator:start -->';
export const END_TAG = '<!-- claude-orchestrator:end -->';

// Cuerpo a inyectar entre los tags. Vive como constante para que un
// solo lugar defina el contrato del modelo. Si cambia, todos los
// CLAUDE.md inyectados se actualizan en el próximo activate.
export const SECTION_BODY = `${START_TAG}
## MCP server: claude-orchestrator

Cuando el user pida agentes paralelos, multi-modelo, batch o "lanza N agentes",
preferí invocar \`spawn_agents\` + \`wait_for_agents\` del MCP server
\`claude-orchestrator\` antes que \`Bash run_in_background\` o el \`Task\` tool.

El orquestador entrega kanban observable, cancel real, model targeting y
fan-in long-poll que esas tools nativas no proveen. El \`cwd\` absoluto de
cada task debe ser el directorio de este workspace para que el dashboard
agrupe correctamente bajo este proyecto.
${END_TAG}`;

export interface InjectFileResult {
  path: string;
  status: 'updated' | 'unchanged' | 'created' | 'skipped' | 'error';
  reason?: string;
}

export interface InjectFileOptions {
  /**
   * Si true y el archivo no existe, lo crea con solo la sección. Si
   * false (modo auto/scan), saltea archivos faltantes.
   */
  createIfMissing?: boolean;
}

export interface InjectScanOptions {
  /**
   * Crea CLAUDE.md en subdirectorios que no lo tienen. Para el modo
   * automático del activate dejarlo en false (no contamina proyectos
   * que el user nunca tocó). Para el comando palette manual ofrecer
   * via QuickPick.
   *
   * NOTA: en modo recursivo (`maxDepth > 1`) `createIfMissing` solo
   * crea en subdirectorios de profundidad 1 (subdir directos del
   * projectsRoot). NO crea en niveles más profundos para evitar
   * llenar el filesystem con archivos vacíos en tasks/, sub-tasks/,
   * etc.
   */
  createIfMissing?: boolean;
  /**
   * Profundidad máxima de scan. Default 4 cubre la convención
   * Trescloud: `<root>/<proyecto>/tasks/<tarea>/CLAUDE.md` es 3
   * niveles abajo del projectsRoot. Más profundo es muy raro y
   * empieza a contaminar con CLAUDE.md anidados de submódulos
   * git o build outputs.
   */
  maxDepth?: number;
}

export interface InjectScanSummary {
  results: InjectFileResult[];
  scannedRoots: string[];
}

// Expande ~ y normaliza. Igual que el resto del plugin para projects.
function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Inserta o actualiza la sección demarcada en un CLAUDE.md específico.
 *
 * Comportamiento:
 *   - Archivo ausente + createIfMissing=false → status='skipped'
 *   - Archivo ausente + createIfMissing=true  → status='created' con solo la sección
 *   - Tags presentes, contenido distinto       → status='updated'
 *   - Tags presentes, contenido igual          → status='unchanged'
 *   - Tags ausentes                            → status='updated' (appendea al final)
 *   - Read/write fail                          → status='error' con reason
 */
export async function injectIntoClaudeMdFile(
  filePath: string,
  options: InjectFileOptions = {},
): Promise<InjectFileResult> {
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      if (!options.createIfMissing) {
        return { path: filePath, status: 'skipped', reason: 'file_missing' };
      }
      // Crea archivo nuevo con solo la sección + newline final.
      return await writeAtomic(filePath, `${SECTION_BODY}\n`, 'created');
    }
    return {
      path: filePath,
      status: 'error',
      reason: `read failed: ${stringifyErr(err)}`,
    };
  }

  // Caso `existing` no es null: archivo presente. Buscar tags.
  const startIdx = existing.indexOf(START_TAG);
  const endIdx = existing.indexOf(END_TAG);

  let next: string;
  if (startIdx >= 0 && endIdx > startIdx) {
    // Tags presentes — reemplazar bloque (incluyendo los tags). El
    // endIdx + END_TAG.length apunta al char DESPUÉS del end tag.
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + END_TAG.length);
    next = before + SECTION_BODY + after;
  } else {
    // Sin tags previos — appendear al final con doble newline para
    // separar del contenido existente.
    const trimmed = existing.replace(/\n+$/, '');
    next = `${trimmed}\n\n${SECTION_BODY}\n`;
  }

  if (next === existing) {
    return { path: filePath, status: 'unchanged' };
  }

  return await writeAtomic(filePath, next, 'updated');
}

async function writeAtomic(
  filePath: string,
  content: string,
  successStatus: 'updated' | 'created',
): Promise<InjectFileResult> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, filePath);
    return { path: filePath, status: successStatus };
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // best-effort cleanup; el archivo destino sigue intacto.
    }
    return {
      path: filePath,
      status: 'error',
      reason: `write failed: ${stringifyErr(err)}`,
    };
  }
}

/**
 * Itera los projectsRoot configurados (subdirectorios directos +
 * recursivo hasta maxDepth) y los workspaceFolders activos de VS Code.
 * Ejecuta la inyección en cada CLAUDE.md encontrado.
 *
 * Estrategia mixta:
 *
 * 1. Workspace folders activos (raíz directa). Captura el caso típico
 *    "user abrió ~/git19 en VS Code" donde el CLAUDE.md vive en la raíz
 *    del repo y los agentes lo heredan al correr en cualquier subdir.
 *    Es la fuente con MÁS impacto para usuarios Trescloud (CLAUDE.md
 *    raíz del repo es la convención).
 *
 * 2. projectsRoot configurado: escanea subdirectorios hasta `maxDepth`
 *    (default 4). Captura convenciones tipo
 *    `<root>/<proyecto>/CLAUDE.md` (depth 1) y
 *    `<root>/<proyecto>/tasks/<tarea>/CLAUDE.md` (depth 3). Ignora
 *    `.git/`, `node_modules/`, `out/`, `dist/` para no encontrar
 *    CLAUDE.md de submódulos o build outputs.
 *
 * Dedup: si el mismo path resulta de las dos fuentes (ej. workspace
 * folder == projectsRoot subdir), se inyecta una sola vez.
 */
export async function injectAuto(
  projectsRoots: string[],
  workspaceFolders: string[],
  options: InjectScanOptions = {},
): Promise<InjectScanSummary> {
  const scannedRoots: string[] = [];
  const results: InjectFileResult[] = [];
  const visited = new Set<string>();
  const maxDepth = options.maxDepth ?? 4;

  // === 1. Workspace folders activos (raíz directa) ===
  // El CLAUDE.md está literalmente en la raíz del workspace.
  for (const rawFolder of workspaceFolders) {
    const folder = path.resolve(expandHome(rawFolder));
    scannedRoots.push(folder);
    const claudeMdPath = path.join(folder, 'CLAUDE.md');
    if (visited.has(claudeMdPath)) continue;
    visited.add(claudeMdPath);
    const result = await injectIntoClaudeMdFile(claudeMdPath, {
      createIfMissing: options.createIfMissing ?? false,
    });
    if (result.status !== 'skipped' || options.createIfMissing) {
      results.push(result);
    }
  }

  // === 2. projectsRoot configurado (recursivo con depth limit) ===
  for (const rawRoot of projectsRoots) {
    const root = path.resolve(expandHome(rawRoot));
    scannedRoots.push(root);

    await walkAndInject(root, 0, maxDepth, visited, results, options);
  }

  return { results, scannedRoots };
}

// Backwards-compat alias del wrapper anterior (solo projectsRoot, sin
// workspaceFolders). Mantenido para tests existentes y para callers que
// no tienen acceso a vscode API. No usado por extension.ts después de
// agregar `injectAuto`.
export async function injectIntoProjectsRoots(
  projectsRoots: string[],
  options: InjectScanOptions = {},
): Promise<InjectScanSummary> {
  return injectAuto(projectsRoots, [], options);
}

// Dirs a ignorar al recorrer recursivamente — son ruidos típicos:
// metadatos git, deps instaladas, build outputs. La lista corta evita
// over-engineering pero cubre los casos que efectivamente aparecen en
// repos Trescloud Odoo y proyectos Node típicos.
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
]);

async function walkAndInject(
  dir: string,
  depth: number,
  maxDepth: number,
  visited: Set<string>,
  results: InjectFileResult[],
  options: InjectScanOptions,
): Promise<void> {
  if (depth > maxDepth) return;

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    results.push({
      path: dir,
      status: 'error',
      reason: `scan failed: ${stringifyErr(err)}`,
    });
    return;
  }

  // Check CLAUDE.md a este nivel. En depth=0 (root del projectsRoot)
  // SOLO actualizamos si existe — no creamos archivos en la raíz del
  // projectsRoot porque típicamente es un padre genérico (ej.
  // `~/git19/docs`) y crear `~/git19/docs/CLAUDE.md` no es lo que el
  // user esperaría. La creación se permite solo a depth=1 (subdir
  // directo = "proyecto" en la terminología del plugin).
  const claudeMdPath = path.join(dir, 'CLAUDE.md');
  const hasClaudeMd = entries.some(
    (e) => e.isFile() && e.name === 'CLAUDE.md',
  );
  const canCreateHere =
    !!options.createIfMissing && depth === 1;
  const shouldAttempt = hasClaudeMd || canCreateHere;
  if (shouldAttempt && !visited.has(claudeMdPath)) {
    visited.add(claudeMdPath);
    const result = await injectIntoClaudeMdFile(claudeMdPath, {
      createIfMissing: canCreateHere,
    });
    if (result.status !== 'skipped' || options.createIfMissing) {
      results.push(result);
    }
  }

  // Recurse en subdirectorios.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    await walkAndInject(
      path.join(dir, entry.name),
      depth + 1,
      maxDepth,
      visited,
      results,
      options,
    );
  }
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
