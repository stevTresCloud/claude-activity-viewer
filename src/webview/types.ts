/* ================================================================
 * types.ts — Tipos compartidos del webview de Claude Orchestrator.
 *
 * Estos tipos describen el shape de la data que va a vivir en el
 * Pinia store y que consumen los componentes del dashboard. Hoy la
 * data es mock hardcoded (ver useAgentsStore); cuando el backend
 * cablee postMessage, este mismo shape va a llegar serializado por
 * el wire — así que los identificadores usan la convención del
 * backend (snake_case en los iso timestamps, camelCase en lo demás)
 * para que el adapter sea trivial.
 *
 * Referencia autoritativa: KANBAN_DESIGN_BRIEF.md §9 + §11 +
 * HANDOFF.md (specs visuales de cada componente).
 * ================================================================ */

// === Unions atómicos ===

/**
 * Estado de un agente individual. Determina en qué sección del
 * dashboard se renderiza:
 *   - running  → NOW PLAYING
 *   - pending  → UP NEXT
 *   - done / failed / cancelled → RECENT
 */
export type AgentStatus = 'running' | 'pending' | 'done' | 'failed' | 'cancelled';

/**
 * Lifecycle de un proyecto, derivado de los agentes que tiene.
 * No se setea manualmente: lo calcula el store a partir de la
 * distribución de status de los agentes del proyecto.
 */
export type ProjectLifecycle = 'active' | 'idle' | 'inactive';

/** Prioridad de un agente pending (solo visible en UP NEXT). */
export type Priority = 'LOW' | 'MED' | 'HIGH';

// === Entidades de dominio ===

/**
 * Project — el nivel más alto de agrupación visual.
 *
 * `lifecycle` no se persiste en el wire: se deriva del store a
 * partir de los agentes asociados (active si tiene running/pending,
 * idle si solo tiene recent <24h, inactive si solo recent >=24h).
 * Acá lo dejamos pre-calculado para que la mock data sea más
 * legible; cuando el backend mande agentes reales, esto se mueve a
 * un getter derivado del store.
 */
export interface Project {
  id: string;
  name: string;
  lifecycle: ProjectLifecycle;
  /** Último update visible del proyecto (último completed_at o started_at). */
  lastUpdateIso: string;
  /** Task activa, si hay una sola; null cuando hay múltiples o ninguna. */
  activeTask: string | null;
}

/**
 * Agent — la entidad principal. Cada agente vive en una sección
 * según su status. Los campos son opcionales según corresponda:
 * running tiene elapsed, pending tiene queued_since, recent tiene
 * completed_at + duration. Lo unificamos en una sola interfaz para
 * que el store pueda filtrarlos con getters simples sin discriminar
 * tipos en cada acceso.
 */
export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;

  // Agrupación visual
  project: string;
  task: string;
  branch: string;
  batchId: string;

  // Solo running
  /** Subtítulo de la tarea (account.move + payslip.line, etc.). */
  subtitle?: string;
  model?: string;
  startedAtIso?: string;
  /** Tiempo transcurrido en ms. Cuando el wire esté, se recalcula
   * con un setInterval en el store. */
  elapsedMs?: number;
  /** % del context window usado (0-100). */
  contextUsedPct?: number;
  /** Tool actual (Edit, Bash, Glob, etc.). */
  currentTool?: string;

  // Solo pending
  priority?: Priority;
  queuedSinceIso?: string;

  // Solo recent (done / failed / cancelled)
  completedAtIso?: string;
  durationMs?: number;
  tokensUsed?: number;
  /** Razón en failed/cancelled (merge conflict, user cancelled, etc.). */
  reason?: string;
}
