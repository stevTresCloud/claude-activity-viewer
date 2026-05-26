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
    };

// === Eventos Webview → Extension (declarados, sin handler todavía) ===

/**
 * Shape de los eventos que el webview enviará al extension host
 * vía `vscode.postMessage(...)`. Declaramos el contrato pero NO
 * cableamos handlers — el bridge ignora silenciosamente cualquier
 * message webview→extension. La UI tampoco los emite todavía: los
 * botones Cancel/Open/Send Message son decorativos.
 *
 * Documentar el shape ahora evita el costo de "inventarlo al
 * implementar" y garantiza que cualquier listener pre-emptivo
 * respete el contrato final.
 */
export type DashboardEventToExtension =
  | { type: 'request_cancel'; agentId: string }
  | { type: 'request_open'; agentId: string }
  | { type: 'request_send_message'; agentId: string; message: string };
