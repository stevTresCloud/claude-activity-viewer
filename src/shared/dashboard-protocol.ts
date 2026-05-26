/* ================================================================
 * dashboard-protocol.ts — Contrato de mensajería extension ↔ webview.
 *
 * Único archivo de tipos compartidos entre los dos rincones del
 * plugin (extension host CJS + webview Vue ESM). Es types-only
 * (cero runtime): los dos lados lo importan y el bundler lo
 * tree-shakea por completo.
 *
 * Por qué un archivo aparte (`src/shared/`) y no duplicar:
 *   - El extension host (tsconfig.json) y el webview
 *     (tsconfig.webview.json) tienen module resolution distintas y
 *     bundlers distintos (esbuild CJS vs vite ESM). Compartir TYPES
 *     es seguro porque no producen runtime; compartir CÓDIGO con
 *     side effects requeriría más cuidado y de momento no hace
 *     falta.
 *   - Los dos lados se actualizan en el mismo PR; el contrato es la
 *     fuente de verdad y rompe la compilación si una punta se
 *     desincroniza.
 *
 * Referencia autoritativa: ARCHITECTURE_PHASE_I.md §4 (los 5
 * eventos extension→webview + 3 webview→extension).
 * ================================================================ */

// === Unions atómicos ===

/**
 * Estado de un agente desde el punto de vista de la UI.
 *
 * NO mapea 1:1 con el `AgentStatus` del runtime (que es
 * 'running'|'completed'|'failed'|'cancelled'); el bridge traduce
 * runtime → wire: 'completed' → 'done', el resto pasa igual.
 *
 * 'pending' está declarado por consistencia con el shape esperado
 * por las vistas (UP NEXT existe en el diseño) pero el bridge no
 * lo emite todavía — no hay queue management.
 */
export type AgentStatus =
  | 'running'
  | 'pending'
  | 'done'
  | 'failed'
  | 'cancelled';

/**
 * Lifecycle de un proyecto. Derivado en el store a partir de los
 * agentes asociados (active si hay 1+ running/pending, idle si
 * solo recent <24h, inactive si todo recent ≥24h). No viaja en el
 * wire.
 */
export type ProjectLifecycle = 'active' | 'idle' | 'inactive';

/** Prioridad de un agente pending. Reservado para queue futuro. */
export type Priority = 'LOW' | 'MED' | 'HIGH';

// === Entidades del wire ===

/**
 * AgentSnapshot — la representación canónica de un agente en el
 * wire. Es la MISMA forma que consume el webview como `Agent`
 * (re-exportado en src/webview/types.ts) para eliminar la
 * necesidad de un adapter manual.
 *
 * Convención de naming:
 *   - camelCase en lo general (`startedAtIso`, `tokensUsed`).
 *   - Los timestamps llevan sufijo `Iso` y son strings ISO 8601 —
 *     fácil de loguear, parsear con `new Date(...)`, y ordenar
 *     lexicograficamente.
 *
 * Todos los campos opcionales tienen sentido condicional al
 * `status`: los `*Iso` de queued/started/completed viven en
 * estados distintos del lifecycle del agente.
 */
export interface AgentSnapshot {
  id: string;
  name: string;
  status: AgentStatus;

  /**
   * sessionId del SDK (capturado en `agent_runner` cuando el SDK lo
   * emite). Opcional porque el SDK puede tardar 1-2 frames en
   * proveerlo y el bridge ya empieza a emitir snapshots antes.
   *
   * Sirve para dedup contra sesiones históricas en disco: una
   * sesión con `entrypoint=sdk-ts` y mismo sessionId que un agente
   * vivo NO debe duplicarse en PAST SESSIONS.
   */
  sessionId?: string;

  // Agrupación visual (cards del dashboard)
  project: string;
  task: string;
  branch: string;
  batchId: string;

  // Solo running
  subtitle?: string;
  model?: string;
  startedAtIso?: string;
  /** Tiempo transcurrido desde startedAtIso al momento del último update. */
  elapsedMs?: number;
  /** % del context window usado (0-100). */
  contextUsedPct?: number;
  currentTool?: string;
  tokensUsed?: number;

  // Solo pending (sin emisor todavía: requiere queue management)
  priority?: Priority;
  queuedSinceIso?: string;

  // Solo recent (done / failed / cancelled)
  completedAtIso?: string;
  durationMs?: number;
  /** Razón del estado terminal (merge conflict, ide_restart, etc.). */
  reason?: string;
}

/**
 * Entrada del log streaming de un agente. Cada AgentEvent del
 * runtime se traduce a uno (o ninguno) de estos; el bridge los
 * acumula en un ringbuffer per-agent (max 1000 FIFO) y los emite
 * al webview en tiempo real.
 *
 * `ts` en epoch ms (no ISO) porque acá lo que importa es ordenar
 * y diff-ear localmente, no loggear humanamente — el formateo
 * humano es responsabilidad de la UI.
 */
export interface LogEntry {
  ts: number;
  kind: 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'usage';
  text?: string;
  /** Nombre del tool, solo en kind='tool_use'. */
  name?: string;
  /** Input crudo del tool, solo en kind='tool_use'. */
  input?: unknown;
  /** Output del tool, solo en kind='tool_result'. */
  result?: string;
  /** Solo en kind='tool_result'. */
  isError?: boolean;
  /**
   * Correla un tool_result con su tool_use previo. Solo en
   * kind='tool_result'. El detail panel futuro lo usa para
   * renderear pares request/response coherentes.
   */
  toolUseId?: string;
  /** Tokens snapshot al momento del usage. Solo en kind='usage'. */
  tokensUsed?: number;
}

/**
 * AgentCompleted — payload terminal cuando el agente llega a un
 * estado final. El bridge lo emite UNA sola vez por agente, justo
 * después del último `agent_status_changed`.
 *
 * Es un subset de `AgentResult` del runtime: la UI solo necesita
 * status final, duración y tokens. El AgentResult completo
 * (input_tokens / cache_read_tokens / cost_usd / finalResponse)
 * queda en el log y en globalState para el detail panel futuro.
 */
export interface AgentCompletedResult {
  status: Exclude<AgentStatus, 'running' | 'pending'>;
  durationMs: number;
  tokensUsed: number;
  reason?: string;
}

// === Eventos Extension → Webview ===

/**
 * Discriminated union de los 5 eventos que el bridge emite al
 * webview vía `webview.postMessage(...)`.
 *
 * Por qué discriminated union y no múltiples interfaces:
 *   El handler en el webview hace `switch (data.type)` y
 *   TypeScript narrow-a el resto de los campos por sí solo. Una
 *   sola fuente de verdad del shape, sin casts.
 */
export type DashboardEventToWebview =
  /** Snapshot inicial al montar el webview. Reemplaza todo el state. */
  | { type: 'agent_list'; agents: AgentSnapshot[] }
  /** Agente nuevo (vino de spawn_agents MCP o de testAgent command). */
  | { type: 'agent_created'; agent: AgentSnapshot }
  /**
   * Actualización parcial de un agente. `status` siempre va (puede
   * ser igual al anterior si solo cambia metadata). `metadata`
   * trae los campos visibles que cambian en runtime: currentTool,
   * contextUsedPct, tokensUsed, subtitle, elapsedMs.
   */
  | {
      type: 'agent_status_changed';
      agentId: string;
      status: AgentStatus;
      metadata?: Partial<AgentSnapshot>;
    }
  /** Entrada nueva en el log streaming. La consumirá el detail panel futuro. */
  | { type: 'agent_log'; agentId: string; entry: LogEntry }
  /** Final del lifecycle del agente. Equivale a status terminal + meta. */
  | {
      type: 'agent_completed';
      agentId: string;
      result: AgentCompletedResult;
    }
  /**
   * Resultado del project scanner: lista de proyectos descubiertos
   * leyendo `claudeOrchestrator.projectsRoot` desde el filesystem.
   * El webview los mergea contra los derivados de agentes vivos.
   */
  | { type: 'projects_from_disk'; projects: ProjectFromDisk[]; scannedAtIso: string }
  /**
   * Resultado del session scanner: lista de sesiones históricas
   * leídas de `~/.claude/projects/<encoded-cwd>/*.jsonl`. El webview
   * las deduplica contra agentes vivos por sessionId+entrypoint.
   */
  | { type: 'sessions_from_disk'; sessions: SessionFromDisk[]; scannedAtIso: string };

// === Eventos Webview → Extension (declarados, sin handler todavía) ===

/**
 * Shape de los eventos que el webview enviará al extension host
 * vía `vscode.postMessage(...)`.
 *
 * Hoy cableados:
 *   - request_resume_session: el botón Resume de una SessionCard.
 *   - request_rescan: el botón "Rescan" del Toolbar.
 *
 * Reservados (decorativos en la UI, sin handler):
 *   - request_cancel, request_open, request_send_message.
 */
export type DashboardEventToExtension =
  | { type: 'request_cancel'; agentId: string }
  | { type: 'request_open'; agentId: string }
  | { type: 'request_send_message'; agentId: string; message: string }
  /** Reanudar una sesión histórica abriendo `claude --resume <id>` en terminal nueva. */
  | { type: 'request_resume_session'; sessionId: string; cwd: string; firstPrompt?: string }
  /** Forzar re-scan inmediato de projects+sessions (botón manual del Toolbar). */
  | { type: 'request_rescan' };

// === Entidades para los scanners (filesystem-derived) ===

/**
 * Proyecto descubierto por el project scanner leyendo subfolders
 * directos de `claudeOrchestrator.projectsRoot`. Existe aunque no
 * haya agentes lanzados todavía — el dropdown del selector los
 * muestra con count `(0 agents · M sessions)`.
 */
export interface ProjectFromDisk {
  /** Path absoluto canónico del proyecto. Usado como id estable. */
  path: string;
  /** Basename del path. Lo que se muestra en la UI. */
  name: string;
  /** Rama git actual. Cadena vacía si no es repo git o detached HEAD. */
  branch: string;
  /** True si `git status --porcelain` reporta cambios. */
  dirty: boolean;
}

/**
 * Sesión histórica descubierta por el session scanner. Cada sesión
 * mapea 1:1 a un `*.jsonl` bajo `~/.claude/projects/<encoded-cwd>/`.
 *
 * El cwd autoritativo viene del campo `cwd` interno del JSONL (no
 * del nombre de carpeta, que NO es bijection reversible cuando el
 * path original contiene guiones).
 */
export interface SessionFromDisk {
  /** Path absoluto al archivo `.jsonl` (id estable, único). */
  filePath: string;
  /** sessionId del SDK (el del header del JSONL). */
  sessionId: string;
  /** cwd absoluto reportado dentro del JSONL. */
  cwd: string;
  /** project derivado con la misma lógica que los agentes vivos. */
  project: string;
  /** task derivado (vacío si no matchea convención `<root>/<proj>/tasks/<task>`). */
  task: string;
  /** Branch capturada por Claude Code en el header. Puede ser "HEAD" (detached). */
  branch: string;
  /** Primer prompt del user, limpiado de `<ide_*>...</ide_*>` y truncado a 80 chars. */
  firstPrompt: string;
  /**
   * Versión más larga del primer prompt (limpia, hasta ~400 chars).
   * Se muestra en SessionCard cuando el user activa expand. Vale
   * mantenerlo separado de `firstPrompt` para que la lista
   * compacta no pague el costo de strings largos en el wire por
   * cada sesión.
   */
  firstPromptFull: string;
  /** ISO 8601 del primer evento user. */
  startedAtIso: string;
  /** ISO 8601 del último evento parseable. Igual a startedAtIso si solo hay 1 line. */
  endedAtIso: string;
  /** Estado inferido del shape del último evento del JSONL. */
  status: 'done' | 'failed' | 'interrupted';
  /**
   * Quién originó la sesión. `claude-vscode` = abierta por Steven en
   * su VS Code chat. `sdk-ts` = abierta por nuestro orchestrator.
   * `cli` = `claude` en terminal. Otros = lo que reporte el JSONL.
   */
  entrypoint: string;
}
