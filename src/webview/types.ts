/* ================================================================
 * types.ts — Tipos del webview (re-exportados del contrato compartido).
 *
 * El shape de los agentes es DEFINIDO en `src/shared/dashboard-protocol`
 * (fuente de verdad del contrato wire entre extension host y webview).
 * Acá lo re-exportamos como `Agent` para que los componentes Vue
 * sigan importando `import type { Agent } from '../types'` sin tener
 * que conocer dónde vive el contrato; si en el futuro el contrato
 * cambia, las vistas no lo notan.
 *
 * `Project` SÍ vive acá: es 100% derivado por el store
 * (`projectsByLifecycle`), no viaja en el wire — el bridge solo
 * manda agentes, los proyectos los infiere la UI.
 * ================================================================ */

import type {
  AgentSnapshot,
  AgentStatus as ProtocolAgentStatus,
  Priority as ProtocolPriority,
  ProjectLifecycle as ProtocolProjectLifecycle,
} from '../shared/dashboard-protocol';

// === Re-exports del protocolo (semántica UI) ===

/**
 * Estado de un agente individual. Determina en qué sección del
 * dashboard se renderiza:
 *   - running  → NOW PLAYING
 *   - pending  → UP NEXT
 *   - done / failed / cancelled → RECENT
 */
export type AgentStatus = ProtocolAgentStatus;

/**
 * Lifecycle de un proyecto, derivado del store a partir de la
 * distribución de status de sus agentes. No se setea manualmente
 * desde el wire.
 */
export type ProjectLifecycle = ProtocolProjectLifecycle;

/** Prioridad de un agente pending (solo visible en UP NEXT). */
export type Priority = ProtocolPriority;

/**
 * Agent — alias del AgentSnapshot del wire. Las vistas lo
 * consumen como `Agent` (semántica UI).
 */
export type Agent = AgentSnapshot;

// === Entidades 100% locales ===

/**
 * Project — derivado en el store, no viaja en el wire.
 *
 * `lifecycle` se infiere de los agentes asociados (active si tiene
 * 1+ running/pending, idle si solo recent <24h, inactive si solo
 * recent ≥24h).
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
