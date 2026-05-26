/* ================================================================
 * scanner-controller.ts — Orquesta los dos scanners + auto-refresh.
 *
 * Responsabilidades:
 *
 *   1. Disparar scan inicial post-activate (no bloquea).
 *   2. Auto-refresh con `setInterval` configurable
 *      (`scannerRefreshSec`; 0 = off).
 *   3. Comando palette `claudeOrchestrator.rescan` → re-ejecuta now.
 *   4. Handler de `request_rescan` del webview (botón futuro).
 *   5. Handler de `request_resume_session` → abre terminal nueva
 *      con `claude --resume <sessionId>`.
 *
 * Se aísla del extension.ts para que la lógica del scanner viva en
 * su propio módulo (testeable + diff coherente).
 *
 * El controller PUBLICA eventos al webview vía `bridge.emit(...)`.
 * Si el webview no está attached, los eventos se descartan; el
 * próximo attach hidrata el state vacío y el siguiente scan los
 * repuebla.
 * ================================================================ */

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DashboardBridge } from './bridge';
import { deriveProjectContextPure } from './bridge';
import { scanProjects, expandUserHome } from './project-scanner';
import { scanSessions } from './session-scanner';
import type {
  DashboardEventToExtension,
  ProjectFromDisk,
  SessionFromDisk,
} from '../shared/dashboard-protocol';
import type { CachedSession } from './session-scanner';

// === Constantes ===

const DEFAULT_REFRESH_SEC = 60;
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/**
 * Key del globalState donde persistimos el cache de sesiones. El
 * payload es `{ projectsRootSnapshot: string[], entries: [filePath, CachedSession][] }`.
 * El snapshot del setting nos permite invalidar el cache completo
 * cuando el user cambia projectsRoot (los project/task derivados
 * en el cache fueron calculados contra el root viejo).
 */
const SCANNER_CACHE_STATE_KEY = 'claudeOrchestrator.sessionScanCache';

interface PersistedScanCache {
  /**
   * Versión del schema del cache. Si cambiamos shape de
   * SessionFromDisk (campos nuevos), bump este número y descartamos
   * cache viejo — más simple que migrar entries field-by-field.
   */
  version: number;
  /** Snapshot del setting cuando se construyó el cache. */
  projectsRootSnapshot: string[];
  /** Entries serializadas como tuples para JSON-compat. */
  entries: Array<[string, CachedSession]>;
}

const CACHE_SCHEMA_VERSION = 1;

// === ScannerController ===

export interface ScannerControllerOptions {
  context: vscode.ExtensionContext;
  channel: vscode.OutputChannel;
  bridge: DashboardBridge;
}

export class ScannerController {
  private readonly context: vscode.ExtensionContext;
  private readonly channel: vscode.OutputChannel;
  private readonly bridge: DashboardBridge;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  /**
   * Cache del último scan. Lo retransmite cuando un webview nuevo
   * se attache (cierre+reapertura del sidebar) — sin esto el user
   * vería el dropdown sin sesiones hasta el siguiente tick.
   */
  private lastProjects: ProjectFromDisk[] = [];
  private lastSessions: SessionFromDisk[] = [];
  private lastScannedAtIso: string | null = null;
  /**
   * Cache incremental de sesiones (filePath → CachedSession). Se
   * persiste en globalState entre arranques del IDE — eso baja el
   * startup scan de ~10s a <500ms en el caso típico (solo 0-2
   * archivos modificados desde el último scan).
   */
  private sessionCache: Map<string, CachedSession> = new Map();
  private disposeAttachCb: (() => void) | null = null;

  constructor(options: ScannerControllerOptions) {
    this.context = options.context;
    this.channel = options.channel;
    this.bridge = options.bridge;
  }

  // ====================================================================
  // === Lifecycle ======================================================
  // ====================================================================

  /**
   * Arranque inicial: dispara un scan async (no awaitea — el
   * activate no debe bloquear) y arma el timer si está configurado.
   */
  start(): void {
    // Hidratar el cache previo del globalState ANTES del primer
    // scan. Si el snapshot de projectsRoot cambió desde el último
    // arranque, descartamos cache (los project/task derivados
    // estarían stales).
    this.hydrateCacheFromState();

    // Primer scan en setImmediate: el activate retorna inmediato y
    // el scanner corre en el siguiente tick del event loop.
    setImmediate(() => {
      void this.rescan('startup');
    });
    this.scheduleNext();
    // Cuando el webview se (re)attache, retransmitimos el último
    // scan que tengamos. Si todavía no hubo scan, no hacemos nada
    // — el primer scan ya emite cuando complete.
    this.disposeAttachCb = this.bridge.onAttach(() => this.replayLastScan());
  }

  /**
   * Lee el cache persistido del globalState al activate. Cuatro
   * razones para descartar (rebuild completo en próximo scan):
   *   1. Nunca se persistió → empty cache.
   *   2. Versión de schema vieja → empty (no migramos field-by-field).
   *   3. projectsRoot cambió → empty (project/task quedarían stale).
   *   4. JSON corrupto → empty (defensivo).
   */
  private hydrateCacheFromState(): void {
    const stored = this.context.globalState.get<PersistedScanCache>(
      SCANNER_CACHE_STATE_KEY,
    );
    if (!stored) return;
    if (stored.version !== CACHE_SCHEMA_VERSION) {
      this.channel.appendLine(
        `[scanner] cache schema mismatch (got ${stored.version}, expected ${CACHE_SCHEMA_VERSION}); rebuilding`,
      );
      return;
    }
    const currentRoots = this.getProjectsRoot();
    if (!shallowArrayEqual(stored.projectsRootSnapshot, currentRoots)) {
      this.channel.appendLine(
        `[scanner] projectsRoot changed since last scan; cache invalidated`,
      );
      return;
    }
    try {
      this.sessionCache = new Map(stored.entries);
      this.channel.appendLine(
        `[scanner] cache hydrated from globalState (${this.sessionCache.size} entries)`,
      );
    } catch (err) {
      this.channel.appendLine(
        `[scanner] !!! cache hydrate failed: ${err instanceof Error ? err.message : String(err)} — rebuilding`,
      );
      this.sessionCache = new Map();
    }
  }

  /** Persiste el cache actual al globalState. Fire-and-forget. */
  private persistCache(): void {
    const payload: PersistedScanCache = {
      version: CACHE_SCHEMA_VERSION,
      projectsRootSnapshot: this.getProjectsRoot(),
      entries: Array.from(this.sessionCache.entries()),
    };
    this.context.globalState.update(SCANNER_CACHE_STATE_KEY, payload).then(
      undefined,
      (err) => {
        this.channel.appendLine(
          `[scanner] !!! cache persist failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  }

  /** Detiene el timer. Llamado en dispose() del extension. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.disposeAttachCb) {
      this.disposeAttachCb();
      this.disposeAttachCb = null;
    }
  }

  /**
   * Re-emite el último scan al webview. Util al re-attach del
   * sidebar para que la sección PAST SESSIONS no quede vacía
   * hasta el próximo tick.
   */
  private replayLastScan(): void {
    if (!this.lastScannedAtIso) return;
    this.channel.appendLine(
      `[scanner] re-emitting cached scan to fresh webview (projects=${this.lastProjects.length} sessions=${this.lastSessions.length})`,
    );
    this.bridge.emit({
      type: 'projects_from_disk',
      projects: this.lastProjects,
      scannedAtIso: this.lastScannedAtIso,
    });
    this.bridge.emit({
      type: 'sessions_from_disk',
      sessions: this.lastSessions,
      scannedAtIso: this.lastScannedAtIso,
    });
  }

  // ====================================================================
  // === Scan ===========================================================
  // ====================================================================

  /**
   * Ejecuta ambos scanners (projects + sessions) en paralelo y
   * publica los resultados al webview. Reentrante guard: si hay
   * un scan en vuelo, el nuevo call se descarta (loggea y sigue).
   */
  async rescan(reason: 'startup' | 'manual' | 'interval'): Promise<void> {
    if (this.inFlight) {
      this.channel.appendLine(`[scanner] skip (${reason}, already in flight)`);
      return;
    }
    this.inFlight = true;
    const startMs = Date.now();
    try {
      const roots = this.getProjectsRoot();
      const scannedAtIso = new Date().toISOString();

      // === Paralelizar ambos scanners ===
      // El project scanner es liviano (~50ms); el session scanner
      // puede demorar segundos. Correrlos a la par evita que el
      // dropdown del selector se quede esperando los counts del
      // session scanner para mostrar los proyectos.
      const [projects, sessionsResult] = await Promise.all([
        scanProjects({ projectsRoot: roots, logger: this.channel }),
        scanSessions({
          claudeProjectsDir: CLAUDE_PROJECTS_DIR,
          projectsRoot: roots,
          // Usamos la variante PURA — sin git fork por sesión. El
          // branch real ya viene en el header del .jsonl, no hace
          // falta releerlo del filesystem por cada uno.
          // Pasamos firstUserPrompt + signalText para que la
          // heurística de path-matching tenga la mayor cantidad de
          // señal disponible (cwd del .jsonl es el workspace de VS
          // Code, no la subcarpeta de la tarea real).
          deriveContext: (
            cwd: string,
            projectsRoot: string[],
            firstUserPrompt?: string,
            signalText?: string,
          ) =>
            deriveProjectContextPure(
              cwd,
              projectsRoot,
              undefined,
              undefined,
              firstUserPrompt,
              signalText,
            ),
          cache: this.sessionCache,
          logger: this.channel,
        }),
      ]);

      const sessions = sessionsResult.sessions;
      // Actualizamos el cache in-memory + persistencia para el
      // próximo arranque.
      this.sessionCache = sessionsResult.nextCache;
      this.persistCache();

      // Guardamos el resultado para retransmitirlo al re-attach
      // del webview ANTES de emitir — así si el emit fallara, el
      // próximo attach sigue teniendo el snapshot disponible.
      this.lastProjects = projects;
      this.lastSessions = sessions;
      this.lastScannedAtIso = scannedAtIso;

      this.bridge.emit({
        type: 'projects_from_disk',
        projects,
        scannedAtIso,
      });
      this.bridge.emit({
        type: 'sessions_from_disk',
        sessions,
        scannedAtIso,
      });

      const elapsed = Date.now() - startMs;
      const { reusedFromCache, reparsed, cleanedUp } = sessionsResult.stats;
      this.channel.appendLine(
        `[scanner] scan complete (${reason}) projects=${projects.length} sessions=${sessions.length} ` +
          `(cache hit=${reusedFromCache} reparsed=${reparsed} cleaned=${cleanedUp}) elapsed=${elapsed}ms`,
      );
    } catch (err) {
      this.channel.appendLine(
        `[scanner] !!! scan error (${reason}): ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.inFlight = false;
    }
  }

  // ====================================================================
  // === Webview → Extension handler ====================================
  // ====================================================================

  /**
   * Despacha mensajes del webview. Solo nos interesan los del
   * scanner; los otros (request_cancel/open/send_message) están
   * sin cablear todavía — el extension.ts puede ampliar el switch.
   */
  handleMessage(msg: DashboardEventToExtension): void {
    switch (msg.type) {
      case 'request_rescan':
        void this.rescan('manual');
        break;
      case 'request_resume_session':
        void this.resumeSession(msg.sessionId, msg.cwd, msg.firstPrompt);
        break;
      default:
        // Otros tipos (cancel/open/send_message): ignorados acá.
        break;
    }
  }

  /**
   * Abre una sesión histórica. Dos modos:
   *
   *   - `chat` (default): invoca el URI handler público del plugin
   *     `anthropic.claude-code`:
   *        vscode://anthropic.claude-code/open?session=<id>
   *     Eso abre la sesión en el sidebar chat del plugin. Limitación
   *     del propio handler: el sessionId debe pertenecer al workspace
   *     actualmente abierto; si no se encuentra, el plugin arranca
   *     conversación fresca.
   *
   *   - `terminal`: terminal VS Code nueva con `claude --resume <id>`.
   *     Más viejo pero independiente del plugin claude-code.
   *
   * Si el modo es `chat` pero el plugin no está instalado, cae
   * automático a `terminal` y avisa con notification.
   */
  private async resumeSession(
    sessionId: string,
    cwd: string,
    firstPrompt?: string,
  ): Promise<void> {
    // Defensa en profundidad: el session-scanner ya valida sessionId
    // contra UUID-canónico al parsear el JSONL, pero el callback del
    // webview viene del runtime y un bug en el frontend podría
    // colar caracteres no validados. Si llega algo raro, abortamos
    // antes de tocar nada externo.
    if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) {
      this.channel.appendLine(
        `[scanner] reject resume: invalid sessionId shape "${sessionId.slice(0, 16)}…"`,
      );
      return;
    }

    const cfg = vscode.workspace.getConfiguration('claudeOrchestrator');
    const confirm = cfg.get<boolean>('resumeConfirm', false);
    const mode = cfg.get<string>('resumeIn', 'chat');

    if (confirm) {
      const label = firstPrompt ? `"${firstPrompt}"` : sessionId.slice(0, 8);
      const target =
        mode === 'terminal' ? 'in a new terminal' : 'in the Claude Code chat';
      const choice = await vscode.window.showWarningMessage(
        `Resume Claude session ${label} ${target}?\n\ncwd: ${cwd}`,
        { modal: false },
        'Resume',
        'Cancel',
      );
      if (choice !== 'Resume') return;
    }

    // === Modo chat (default) ===
    // El plugin anthropic.claude-code tiene una limitación documentada:
    // "The session must belong to the workspace currently open in
    // VS Code". Si no, arranca conversación vacía. Detectamos eso
    // ANTES de invocar el URI para no dar UX de "click y no pasa nada".
    //
    // Triple guarda:
    //   1. ¿El plugin está instalado? Si no → terminal + info.
    //   2. ¿El cwd de la sesión está dentro de algún workspace folder?
    //      Si no → terminal + info (el chat arrancaría en blanco).
    //   3. Si pasa ambas → URI handler.
    if (mode === 'chat') {
      const claudeExt = vscode.extensions.getExtension('anthropic.claude-code');
      if (!claudeExt) {
        this.channel.appendLine(
          `[scanner] resume mode=chat but 'anthropic.claude-code' extension is not installed — falling back to terminal`,
        );
        void vscode.window.showInformationMessage(
          'Install the Claude Code extension to resume sessions in the sidebar chat. Falling back to terminal.',
        );
        // cae a modo terminal abajo.
      } else if (!this.cwdInsideWorkspace(cwd)) {
        this.channel.appendLine(
          `[scanner] resume mode=chat but session cwd "${cwd}" is outside current workspace — falling back to terminal (the chat would open empty)`,
        );
        void vscode.window.showInformationMessage(
          `Session cwd is outside your current VS Code workspace; opening in terminal instead. Open the folder "${cwd}" in VS Code to resume in the sidebar chat.`,
        );
        // cae a modo terminal abajo.
      } else {
        try {
          await vscode.commands.executeCommand(
            'vscode.open',
            vscode.Uri.parse(
              `vscode://anthropic.claude-code/open?session=${sessionId}`,
            ),
          );
          this.channel.appendLine(
            `[scanner] resume (chat) session=${sessionId.slice(0, 8)}`,
          );
          return;
        } catch (err) {
          this.channel.appendLine(
            `[scanner] !!! resume in chat failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)} — falling back to terminal`,
          );
          // Cae al modo terminal abajo.
        }
      }
    }

    // === Modo terminal (o fallback) ===
    // Nombre legible: `claude resume <prompt-corto>` para que la
    // pestaña de terminal sea identificable cuando haya varias.
    const tabName = firstPrompt
      ? `claude resume: ${truncate(firstPrompt, 32)}`
      : `claude resume: ${sessionId.slice(0, 8)}`;

    try {
      const terminal = vscode.window.createTerminal({
        cwd,
        name: tabName,
      });
      terminal.show(true);
      // El comando se envía a la terminal recién abierta. El cliente
      // claude se enciende en 2-3s; la terminal queda visible
      // mientras tanto. El último arg `true` agrega newline (ejecuta).
      terminal.sendText(`claude --resume ${sessionId}`, true);
      this.channel.appendLine(
        `[scanner] resume (terminal) session=${sessionId.slice(0, 8)} cwd=${cwd}`,
      );
    } catch (err) {
      this.channel.appendLine(
        `[scanner] !!! resume failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      vscode.window.showErrorMessage(
        `Failed to resume session: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ====================================================================
  // === Helpers internos ===============================================
  // ====================================================================

  /**
   * Chequea si un `cwd` (path absoluto) está dentro de alguno de
   * los workspace folders abiertos en VS Code. Usado para predecir
   * si el plugin claude-code va a poder retomar la sesión en su
   * sidebar chat (su URI handler rechaza sessionIds cuyo cwd no
   * pertenezca al workspace actual).
   *
   * Match inclusivo: el cwd puede ser igual al folder o un subpath
   * de él. Sin workspace folders abiertos → false (no podemos
   * confirmar match, mejor caer a terminal).
   */
  private cwdInsideWorkspace(cwd: string): boolean {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return false;
    // path.resolve normaliza separadores + ..; suficiente para
    // matchear "/a/b/c" con root "/a/b".
    const normCwd = path.resolve(cwd);
    for (const folder of folders) {
      const folderPath = path.resolve(folder.uri.fsPath);
      if (normCwd === folderPath || normCwd.startsWith(folderPath + path.sep)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Lee y expande `claudeOrchestrator.projectsRoot`. Mismo
   * tratamiento que el bridge para que las dos puntas coincidan
   * (un proyecto se deriva igual en ambos lados).
   */
  private getProjectsRoot(): string[] {
    const cfg = vscode.workspace.getConfiguration('claudeOrchestrator');
    const raw = cfg.get<string[]>('projectsRoot', []);
    return raw.map((p) => expandUserHome(p));
  }

  /**
   * Agenda el siguiente scan según la setting. `0` deshabilita el
   * timer; cualquier valor positivo lo arranca en segundos.
   * Llamado al `start()` y se podría re-llamar si la setting
   * cambia en runtime (no implementado hoy — el user reload).
   */
  private scheduleNext(): void {
    const cfg = vscode.workspace.getConfiguration('claudeOrchestrator');
    const intervalSec = cfg.get<number>('scannerRefreshSec', DEFAULT_REFRESH_SEC);
    if (!intervalSec || intervalSec <= 0) {
      this.channel.appendLine('[scanner] auto-refresh disabled');
      return;
    }
    this.timer = setInterval(() => {
      void this.rescan('interval');
    }, intervalSec * 1000);
    this.channel.appendLine(`[scanner] auto-refresh every ${intervalSec}s`);
  }
}

// === Helper local ===

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Comparación shallow para validar projectsRoot snapshot del cache. */
function shallowArrayEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
