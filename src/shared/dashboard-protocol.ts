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

// === Constantes compartidas ===

/**
 * Capacidad del ringbuffer per-agent del log streaming. Bridge y
 * store del webview lo respetan en paralelo: el bridge para el
 * persisted log (globalState), el store para la copia in-memory
 * del webview. Mantener UN solo valor canónico evita drifts cuando
 * uno se actualiza y el otro no.
 */
export const LOG_RING_MAX = 1000;

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
 *
 * 'needs_review' es una PROMOCIÓN sobre `done`/`failed` que el bridge
 * aplica al cierre de `wait_for_agents` cuando los mecanismos D + A
 * (verification) detectan algo que el operador debe revisar:
 *   - D: el agente declaró `decisions_made_without_consultation` o
 *     `uncertainties` no vacíos en su exit report.
 *   - A: el critic Haiku emitió 1+ flags al revisar el diff.
 * El agente puede haber terminado limpio desde su perspectiva pero
 * el orchestrator lo marca para evitar merges silenciosos sospechosos.
 */
export type AgentStatus =
  | 'running'
  | 'pending'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'needs_review';

/**
 * Estados terminales: los que indican "el agente terminó su lifecycle, no
 * volverá a estar corriendo". Lo respetan varios sitios cross-archivo
 * (bridge `emitStatusChange` invariante, bridge `runWait` pending detection,
 * store `recent` filter, AgentCardRecent STATUS_PRESENTATION).
 *
 * Mantener este enum + `isTerminalStatus` como SSoT evita drift cuando se
 * agrega un nuevo terminal status (ej. la adición de `'needs_review'` en
 * Mecanismo D+A obligó a actualizar 4 sitios — sin la constante, uno se
 * olvidó y permitía un evento late del SDK degradar `needs_review` a
 * `running`).
 */
export const TERMINAL_STATUSES = [
  'done',
  'failed',
  'cancelled',
  'needs_review',
] as const satisfies readonly AgentStatus[];

export type TerminalAgentStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminalStatus(s: AgentStatus): s is TerminalAgentStatus {
  return (TERMINAL_STATUSES as readonly AgentStatus[]).includes(s);
}

/**
 * Lifecycle de un proyecto. Derivado en el store a partir de los
 * agentes asociados (active si hay 1+ running/pending, idle si
 * solo recent <24h, inactive si todo recent ≥24h). No viaja en el
 * wire.
 */
export type ProjectLifecycle = 'active' | 'idle' | 'inactive';

/** Prioridad de un agente pending. Reservado para queue futuro. */
export type Priority = 'LOW' | 'MED' | 'HIGH';

/**
 * Modo de verificación del agente (Mecanismo D + A). Capturado al
 * spawn y persistido en el snapshot; la UI lo usa para decidir si
 * renderizar el VerificationBadge en la card RECENT. Conjunto cerrado:
 * coincide con el enum del setting `claudeOrchestrator.verification`.
 */
export type VerificationMode = 'none' | 'structured' | 'critic' | 'both' | 'human-review';

/**
 * Estado heurístico del transport MCP. El bridge lo deriva del tiempo
 * que llevan los `wait_for_agents` activos: si alguno está vivo > 60s
 * sin haber resuelto, asumimos que el transport HTTP **puede** haber
 * tirado (síntoma exacto del field report v0.1.0 — los agentes siguen
 * corriendo pero el long-poll del chat caller nunca recibe respuesta).
 * Se reinicia a `'healthy'` cuando los waiters resuelven.
 *
 * El banner del dashboard que renderiza esto es opt-in via setting
 * `claudeOrchestrator.showTransportState` (default false) hasta que la
 * heurística esté validada en uso productivo.
 */
export type TransportState = 'healthy' | 'degraded';

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
  /**
   * ISO 8601 del último evento de hook que el viewer procesó para este
   * agente (start, tool, stop). El webview lo usa para la heurística de
   * liveness: un agente `running` cuyo `lastActivityIso` quedó hace más
   * del umbral de staleness se pinta como "sin actividad reciente" (no
   * terminal — puede seguir vivo en una tool larga). No hay heartbeat:
   * el único "sigue vivo" que tenemos es el próximo evento de hook.
   */
  lastActivityIso?: string;
  /** % del context window usado (0-100). */
  contextUsedPct?: number;
  /**
   * Tokens cargados en el context window activo del modelo. Suma
   * input + cacheRead + cacheCreation. Coincide matemáticamente
   * con `contextUsedPct` (= contextTokens / 200_000 * 100). El
   * ContextBar lo usa como numerador de la fracción "Xk / 200k".
   *
   * Distinto de `tokensUsed` que mide el COSTO billable del turno
   * (sin cache, ~10× más chico). Coexisten porque la UI muestra
   * cosas distintas: la barra quiere "cuánto del context se llenó"
   * (incluye cache), las cards RECENT quieren "cuánto consumió"
   * (sin cache, costo efectivo).
   */
  contextTokens?: number;
  currentTool?: string;
  tokensUsed?: number;
  /**
   * Costo billable acumulado en USD (lo que cobra Anthropic por este
   * agente). Viene del SDK como `total_cost_usd` en el `result` final
   * y se actualiza en cada turn vía el `usage` event. Distinto a
   * `tokensUsed`: tokens es cuántos tokens consumió, `costUsd` es
   * cuánta plata salió de la cuenta (depende del modelo + cache hits).
   *
   * Opcional porque en runs muy cortos puede llegar como 0 antes del
   * primer turn completo. La UI muestra "—" cuando es undefined o 0.
   */
  costUsd?: number;

  // Solo pending (sin emisor todavía: requiere queue management)
  priority?: Priority;
  queuedSinceIso?: string;

  // Solo recent (done / failed / cancelled)
  completedAtIso?: string;
  durationMs?: number;
  /** Razón del estado terminal (merge conflict, ide_restart, etc.). */
  reason?: string;

  // === Verification (Mecanismo D + A) — campos UI-visibles ===
  //
  // El bloque completo del wire vive en WaitForAgentsAgentResult.verification.
  // Acá replicamos UN subset (3 booleanos + mode) que la card del sidebar
  // necesita para renderear el VerificationBadge sin tener que cruzar el
  // wire de wait_for_agents — el sidebar mantiene su state desde
  // agent_status_changed.

  /**
   * Modo de verification capturado al spawn. Lockeado para todo el
   * lifecycle del agente. La UI lo usa para decidir si mostrar el
   * VerificationBadge en RECENT (modo === 'none' → sin badge).
   */
  verificationMode?: VerificationMode;
  /**
   * `true` cuando el bridge ya corrió el paso de verification del agente
   * (parse del exit + critic spawn si aplica). Mientras es undefined o
   * false, el badge muestra estado "pending" o no se renderiza.
   */
  verificationReviewed?: boolean;
  /**
   * `true` cuando el bridge promovió a `needs_review` (por D o por A).
   * Distinto del `status === 'needs_review'`: ese es el wire-status; este
   * flag distingue "promovido vs naturalmente done" para el color del
   * badge (verde si reviewed y NO promoted; naranja si promoted).
   */
  verificationPromoted?: boolean;
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
  /**
   * Duración total del agente. Opcional: cuando la extensión arrancó
   * mid-flight y el primer evento que vio fue el SubagentStop, no sabemos
   * cuándo arrancó el agente, así que la omitimos en vez de reportar ~0
   * (la UI muestra "—" en vez de "0s"). Cuando sí vimos el start, va el
   * delta real.
   */
  durationMs?: number;
  tokensUsed: number;
  reason?: string;
}

// === wait_for_agents (MCP tool) ===

/**
 * Hallazgo del critic Haiku tras revisar el diff `headBefore..HEAD`.
 * Wire-out del `parseCriticOutput` del runtime. Severidades:
 *   - `high`: probable defecto (assertion flip, SQL inválido, etc.).
 *   - `med`: sospechoso, merece review humana.
 *   - `low`: estilo, menor, o falla interna del critic (parse error).
 * `file` y `line` son opcionales porque el critic puede flaggear
 * patrones cross-file ("nuevas dependencias externas sin justificar")
 * que no se anclan a una línea específica.
 */
export interface CriticFinding {
  file?: string;
  line?: number;
  severity: 'high' | 'med' | 'low';
  summary: string;
}

/**
 * Reporte estructurado que el agente devuelve en su último text block
 * cuando `verification ≠ 'none'`. Forma autoritativa en
 * `runtime/exit-schema.ts` (Zod schema EXIT_SCHEMA_V1).
 *
 * Nota: cuando `parseExitSchema` falla, este campo queda undefined en
 * `WaitForAgentsAgentResult` — el chat caller lo distingue de "agente
 * que cumplió pero declaró vacío" mirando si la key existe.
 */
export interface ExitReport {
  status: 'ok' | 'needs_review' | 'failed';
  files_changed: string[];
  evidence_run: string[];
  decisions_made_without_consultation: string[];
  uncertainties: string[];
}

/**
 * Bloque de verification del wire. Lo incluimos en
 * `WaitForAgentsAgentResult` cuando el bridge corrió Mecanismo D y/o A.
 * Los 3 sub-campos son independientes:
 *   - `mode`: qué setting estaba activo al cierre.
 *   - `exit_report`: lo que el agente declaró (si parseó).
 *   - `critic_findings`: lo que el critic Haiku flaggeó (si corrió).
 *   - `auto_promoted_reason`: por qué el bridge promovió a needs_review.
 *     Strings estables para métricas: 'decisions' | 'uncertainties' |
 *     'critic_flags'. Vacío cuando el status NO fue auto-promovido.
 */
export interface VerificationReport {
  mode: 'none' | 'structured' | 'critic' | 'both' | 'human-review';
  exit_report?: ExitReport;
  exit_parse_reason?: string;
  critic_findings?: CriticFinding[];
  critic_cost_usd?: number;
  critic_duration_ms?: number;
  auto_promoted_reason?: string;
}

/**
 * Resultado por agente terminado dentro del wait. Wire compacto del
 * StoredAgent en estado terminal: lo lee el chat externo para usar
 * el output del agente como contexto.
 */
export interface WaitForAgentsAgentResult {
  agent_id: string;
  status: Exclude<AgentStatus, 'running' | 'pending'>;
  /**
   * Último text block que el agente emitió mid-stream. Para `done`
   * es el mensaje de cierre. Para `cancelled`/`failed` puede ser el
   * último progreso ANTES del corte (NO el string del runner tipo
   * "User cancelled" — preferimos lo que el agente alcanzó a decir).
   */
  last_message: string | null;
  duration_ms: number;
  tokens_used: number;
  /**
   * Costo billable acumulado del agente en USD (`total_cost_usd` del
   * SDK). El chat caller lo usa para reportar costo al user en el
   * resumen consolidado, o agregar costos por batch.
   */
  cost_usd: number;
  model?: string;
  /**
   * Razón terminal cuando aplica: `user_cancelled`, `ide_restart`,
   * `max_runtime_exceeded`, `not_found` (cuando el agentId no
   * existe en el registry).
   */
  reason?: string;
  /**
   * Bloque verification del Mecanismo D + A. Presente cuando el
   * setting `claudeOrchestrator.verification` ≠ 'none' al momento
   * de `wait_for_agents`. Opcional para backwards-compat con consumers
   * que no lo lean.
   */
  verification?: VerificationReport;
}

/**
 * Resultado por agente que SIGUE running cuando el wait_for_agents
 * timed out. Incluye `last_message_partial` (lo que dijo el agente
 * hasta ahora) + `suspected_stuck` (flag heurístico de inactividad).
 */
export interface WaitForAgentsAgentPending {
  agent_id: string;
  /** "running" para los pending; otros estados no aparecen acá. */
  status: 'running';
  last_message_partial: string | null;
  /** ISO timestamp del último evento que el bridge procesó. */
  last_activity_at: string;
  /**
   * `true` si `now - last_activity_at > stuckDetectionSec` (setting
   * `claudeOrchestrator.stuckDetectionSec`, default 60s). El bridge
   * NO cancela el agente — solo señala. El chat externo decide.
   */
  suspected_stuck: boolean;
}

/**
 * Respuesta completa del MCP tool `wait_for_agents`. Compatible con
 * el patrón retry: si `timed_out: true` y `pending: [...]`, el chat
 * externo re-llama con los pending agent_ids.
 */
export interface WaitForAgentsResult {
  results: WaitForAgentsAgentResult[];
  pending: WaitForAgentsAgentPending[];
  timed_out: boolean;
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
  | { type: 'sessions_from_disk'; sessions: SessionFromDisk[]; scannedAtIso: string }
  /**
   * Hidratación on-demand del ringbuffer de logs de un agente. Lo
   * emite el bridge cuando el detail panel (editor tab) lo solicita
   * via `request_hydrate_logs`. Lleva TODOS los entries del
   * ringbuffer del bridge en un solo evento (vs N×agent_log) — para
   * un agente con 1000 entries, esto es ~1 frame en vez de 1000.
   */
  | { type: 'agent_log_history'; agentId: string; entries: LogEntry[] }
  /**
   * Transición del estado heurístico del transport. Se emite SOLO
   * cuando cambia (no en cada update); la UI guarda el último valor
   * recibido. El sidebar puede usarlo para mostrar un banner con
   * "transport may have dropped — re-call wait_for_agents to recover".
   */
  | { type: 'transport_state_changed'; state: TransportState };

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
  | { type: 'request_rescan' }
  /**
   * Pide al bridge que emita el ringbuffer completo de logs del
   * agente como un único `agent_log_history`. Lo dispara el detail
   * panel al montar para hidratar el LogStream sin esperar a que
   * lleguen entries nuevos.
   */
  | { type: 'request_hydrate_logs'; agentId: string }
  /**
   * Abre (o re-enfoca) el detail panel del agente en un editor tab.
   * Lo dispara el click en el body de una card del sidebar. El
   * DetailPanelManager del extension host crea el WebviewPanel y le
   * inyecta `window.__claudeOrchestrator.agentId`.
   */
  | { type: 'request_show_detail'; agentId: string }
  /**
   * Dispara el comando palette `Claude Orchestrator: Test Agent` desde
   * la UI. Lo emite el botón "Run Test Agent" del empty-hint cuando el
   * dashboard está sin agentes. Atajo de discoverability — equivalente
   * a Ctrl+Shift+P → "Test Agent" pero un click.
   */
  | { type: 'request_run_test_agent' }
  /**
   * Dispara el inject de CLAUDE.md desde el toolbar del dashboard.
   * Modo auto (createIfMissing=false) — solo actualiza CLAUDE.md
   * existentes en workspace folders + projectsRoot. Para crear nuevos,
   * el comando palette `Inject MCP directive into workspaces` ofrece la
   * variante con creación.
   */
  | { type: 'request_inject_claude_md' };

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
