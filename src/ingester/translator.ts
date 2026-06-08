/* ================================================================
 * translator.ts — Traduce eventos de hook → eventos del store.
 *
 * Es la sustancia del re-enfoque a viewer: una pequeña state machine
 * por agente que convierte el ciclo de vida que llega por hooks
 * (SubagentStart → PreToolUse/PostToolUse* → SubagentStop) en los
 * `DashboardEventToWebview` que el store del kanban YA consume
 * (agent_created / agent_status_changed / agent_log / agent_completed).
 *
 * Diseño:
 *   - Stateful pero aislado: mantiene un Map<agentId, AgentState> con
 *     lo mínimo para derivar elapsed/duration y no re-emitir cards.
 *   - Puro respecto al entorno: NO lee settings ni corre git. El cómo
 *     derivar project/task/branch del cwd entra por inyección
 *     (`deriveContext`), así los tests pasan un stub y no tocan disco.
 *   - El reloj (`now`) también es inyectable → duraciones reproducibles.
 *
 * Guards defensivos (cubiertos por tests):
 *   - Evento de un agente que nunca tuvo SubagentStart (la extensión
 *     arrancó mid-flight) → lazy-create del card antes del evento.
 *   - SubagentStart duplicado → no re-emite, idempotente.
 *   - Eventos después de SubagentStop → ignorados (el agente ya cerró).
 *   - Pre/PostToolUse de la sesión principal (sin agent_id) → ignorados
 *     (en F1 el viewer muestra subagentes, no la sesión interactiva).
 * ================================================================ */

import type {
  AgentSnapshot,
  DashboardEventToWebview,
  LogEntry,
} from '../shared/dashboard-protocol';
import { truncate } from '../shared/format';
import type {
  HookEvent,
  PostToolUseEvent,
  PreToolUseEvent,
  SessionEndEvent,
  StopEvent,
  SubagentStartEvent,
  SubagentStopEvent,
} from './hook-events';

// Tope del texto de un tool_result que guardamos en el log ring. El
// forwarder ya acota tool_response a ~2000 chars; este es un segundo
// cinturón por si un tool_response objeto se serializa más grande.
const MAX_LOG_RESULT_CHARS = 4000;

/**
 * Estado mínimo que el translator mantiene por agente vivo. No es el
 * snapshot completo (ese vive en el store del webview); solo lo que
 * hace falta para derivar deltas (elapsed/duration) y evitar
 * re-emitir cards.
 */
interface AgentState {
  name: string;
  cwd: string;
  project: string;
  task: string;
  branch: string;
  sessionId?: string;
  startedAtMs: number;
  lastActivityMs: number;
  /**
   * true solo cuando vimos el SubagentStart real de este agente. Si es
   * false, lo materializamos con un lazy-create (la extensión arrancó
   * mid-flight) y `startedAtMs` es una estimación, no el arranque real →
   * no podemos reportar una duración honesta al cerrar.
   */
  sawStart: boolean;
  /** transcript_path del SubagentStart — puerta al detalle. */
  transcriptPath?: string;
  /** agent_transcript_path del SubagentStop — puerta al detalle. */
  agentTranscriptPath?: string;
  /** true tras SubagentStop: ignora eventos tardíos. */
  terminal: boolean;
}

export interface DerivedContext {
  project: string;
  task: string;
  branch: string;
}

export interface HookTranslatorDeps {
  /** Deriva project/task/branch del cwd. Inyectado para testear sin git. */
  deriveContext: (cwd: string) => DerivedContext;
  /** Reloj inyectable (default Date.now) para duraciones reproducibles. */
  now?: () => number;
}

export class HookTranslator {
  private readonly agents = new Map<string, AgentState>();
  private readonly deriveContext: (cwd: string) => DerivedContext;
  private readonly now: () => number;

  constructor(deps: HookTranslatorDeps) {
    this.deriveContext = deps.deriveContext;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Traduce un evento de hook validado a 0+ eventos del store. El
   * orden importa: un lazy-create siempre precede al evento que lo
   * disparó para que el store tenga el card antes de mutarlo.
   */
  translate(event: HookEvent): DashboardEventToWebview[] {
    switch (event.hook_event_name) {
      case 'SubagentStart':
        return this.onSubagentStart(event);
      case 'PreToolUse':
        return this.onPreToolUse(event);
      case 'PostToolUse':
        return this.onPostToolUse(event);
      case 'SubagentStop':
        return this.onSubagentStop(event);
      // Fin de turno: los subagentes foreground ya cerraron con su propio
      // SubagentStop antes de este Stop; uno que siga vivo fue interrumpido
      // (cancel del usuario, crash). Lo cerramos como `cancelled`, salvo los
      // que sigan corriendo en background (esos cruzan el Stop legítimamente).
      case 'Stop':
        return this.onSessionClose(event, 'session_stop', backgroundTaskIds(event.background_tasks));
      // Fin de sesión: nada puede seguir vivo, ni siquiera background → sin guard.
      case 'SessionEnd':
        return this.onSessionClose(event, 'session_end', new Set());
      case 'SessionStart':
        return [];
    }
  }

  /** Lectura del transcript del agente (para el detail panel de F3). */
  getTranscriptPath(agentId: string): string | undefined {
    const state = this.agents.get(agentId);
    return state ? this.transcriptPathOf(state) : undefined;
  }

  /**
   * Transcript autoritativo del agente: el `agent_transcript_path` del
   * Stop gana al `transcript_path` del Start. Regla única reusada por
   * `getTranscriptPath`, `buildSnapshot` y el cierre del Stop.
   */
  private transcriptPathOf(state: AgentState): string | undefined {
    return state.agentTranscriptPath ?? state.transcriptPath;
  }

  // === Handlers por evento ===

  private onSubagentStart(event: SubagentStartEvent): DashboardEventToWebview[] {
    // Idempotente: un SubagentStart repetido para un agente ya conocido
    // no re-emite el card (evita duplicados si el hook se dispara dos
    // veces o si el archivo spool se re-procesa).
    if (this.agents.has(event.agent_id)) return [];

    const state = this.createAgentState(event.agent_id, event.cwd, event.session_id, {
      name: event.agent_type,
      transcriptPath: event.transcript_path,
      sawStart: true,
    });
    this.agents.set(event.agent_id, state);

    return [{ type: 'agent_created', agent: this.buildSnapshot(event.agent_id, state) }];
  }

  private onPreToolUse(event: PreToolUseEvent): DashboardEventToWebview[] {
    const ctx = this.beginToolEvent(event);
    if (!ctx) return [];
    const { agentId, events, nowMs, elapsedMs } = ctx;

    events.push({
      type: 'agent_status_changed',
      agentId,
      status: 'running',
      metadata: {
        currentTool: event.tool_name,
        elapsedMs,
        lastActivityIso: new Date(nowMs).toISOString(),
      },
    });
    events.push({
      type: 'agent_log',
      agentId,
      entry: {
        ts: nowMs,
        kind: 'tool_use',
        name: event.tool_name,
        input: event.tool_input,
      },
    });
    return events;
  }

  private onPostToolUse(event: PostToolUseEvent): DashboardEventToWebview[] {
    const ctx = this.beginToolEvent(event);
    if (!ctx) return [];
    const { agentId, events, nowMs, elapsedMs } = ctx;

    const entry: LogEntry = {
      ts: nowMs,
      kind: 'tool_result',
      result: truncate(stringifyResult(event.tool_response), MAX_LOG_RESULT_CHARS),
      isError: detectToolError(event.tool_response),
    };
    if (event.tool_use_id) entry.toolUseId = event.tool_use_id;

    events.push({ type: 'agent_log', agentId, entry });
    events.push({
      type: 'agent_status_changed',
      agentId,
      status: 'running',
      // Limpiamos currentTool ('' falsy → la UI esconde la línea): la tool
      // ya terminó; mantener el nombre haría parecer que sigue en ella
      // hasta el próximo PreToolUse.
      metadata: {
        currentTool: '',
        elapsedMs,
        lastActivityIso: new Date(nowMs).toISOString(),
      },
    });
    return events;
  }

  private onSubagentStop(event: SubagentStopEvent): DashboardEventToWebview[] {
    // Pasamos session_id también acá: si Stop es el PRIMER evento que vemos
    // de un agente (extensión arrancada mid-flight), el lazy-create debe
    // agruparlo por su sesión igual que lo hace el path de tools.
    const { state, events } = this.ensureAgent(
      event.agent_id,
      event.cwd,
      event.session_id,
    );
    // Stop duplicado para un agente ya terminal → no-op.
    if (state.terminal) return [];

    state.terminal = true;
    state.agentTranscriptPath = event.agent_transcript_path;

    const nowMs = this.now();
    state.lastActivityMs = nowMs;
    const completedAtIso = new Date(nowMs).toISOString();
    // Solo reportamos duración si vimos el arranque real. Si el Stop fue
    // el primer evento (lazy-create), `startedAtMs` es ~ahora → un
    // durationMs ~0 mentiría; lo dejamos undefined y la UI muestra "—".
    const durationMs = state.sawStart ? nowMs - state.startedAtMs : undefined;

    const metadata: Partial<AgentSnapshot> = {
      completedAtIso,
      lastActivityIso: completedAtIso,
      transcriptPath: this.transcriptPathOf(state),
    };
    if (durationMs !== undefined) {
      metadata.durationMs = durationMs;
      metadata.elapsedMs = durationMs;
    }

    events.push({
      type: 'agent_status_changed',
      agentId: event.agent_id,
      status: 'done',
      metadata,
    });
    events.push({
      type: 'agent_completed',
      agentId: event.agent_id,
      result: { status: 'done', durationMs, tokensUsed: 0 },
    });
    return events;
  }

  /**
   * Reconcilia los subagentes que seguían vivos cuando su sesión cerró
   * el turno (`Stop`) o terminó (`SessionEnd`). Sin un `SubagentStop`
   * propio el agente quedaría `running` para siempre (lo vimos al
   * cancelar con Esc); acá lo cerramos como `cancelled`.
   *
   * No reportamos `durationMs`: sabemos cuándo lo notamos (el cierre),
   * no cuándo murió de verdad → la UI muestra "—" en vez de mentir.
   *
   * `liveBackgroundIds` excluye los subagentes que siguen corriendo en
   * background (vienen en `Stop.background_tasks`): cruzan el Stop sin
   * estar muertos. En `SessionEnd` el set va vacío (ya no corre nada).
   */
  private onSessionClose(
    event: StopEvent | SessionEndEvent,
    reason: 'session_stop' | 'session_end',
    liveBackgroundIds: Set<string>,
  ): DashboardEventToWebview[] {
    if (!event.session_id) return [];

    const nowMs = this.now();
    const completedAtIso = new Date(nowMs).toISOString();
    const events: DashboardEventToWebview[] = [];

    for (const [agentId, state] of this.agents) {
      if (state.terminal) continue;
      if (state.sessionId !== event.session_id) continue;
      if (liveBackgroundIds.has(agentId)) continue;

      state.terminal = true;
      state.lastActivityMs = nowMs;

      const metadata: Partial<AgentSnapshot> = {
        completedAtIso,
        lastActivityIso: completedAtIso,
        transcriptPath: this.transcriptPathOf(state),
      };

      events.push({ type: 'agent_status_changed', agentId, status: 'cancelled', metadata });
      events.push({
        type: 'agent_completed',
        agentId,
        result: { status: 'cancelled', tokensUsed: 0, reason },
      });
    }
    return events;
  }

  // === Helpers ===

  /**
   * Construye el AgentState inicial. Único lugar donde vive el shape de
   * arranque de un agente: lo comparten el alta explícita (SubagentStart,
   * con name/transcript del payload) y el lazy-create degradado (nombre
   * derivado del id). `now`/`deriveContext` inyectados → testeable.
   */
  private createAgentState(
    agentId: string,
    cwd: string | undefined,
    sessionId: string | undefined,
    opts?: { name?: string; transcriptPath?: string; sawStart?: boolean },
  ): AgentState {
    const nowMs = this.now();
    const context = this.deriveContext(cwd ?? '');
    const shortId = agentId.slice(0, 8);
    return {
      name: opts?.name ?? `agent-${shortId}`,
      cwd: cwd ?? '',
      project: context.project,
      task: context.task,
      branch: context.branch,
      sessionId,
      startedAtMs: nowMs,
      lastActivityMs: nowMs,
      sawStart: opts?.sawStart ?? false,
      transcriptPath: opts?.transcriptPath,
      terminal: false,
    };
  }

  /**
   * Devuelve el state del agente, creándolo (+ emitiendo agent_created)
   * si no existía. Cubre el caso "la extensión arrancó después de que
   * el agente empezó": el primer evento que llega lo materializa con
   * metadata degradada en vez de descartarlo. Los eventos de creación
   * quedan en `events` para preceder al resto.
   */
  private ensureAgent(
    agentId: string,
    cwd: string | undefined,
    sessionId?: string,
  ): { state: AgentState; events: DashboardEventToWebview[] } {
    const existing = this.agents.get(agentId);
    if (existing) return { state: existing, events: [] };

    const state = this.createAgentState(agentId, cwd, sessionId);
    this.agents.set(agentId, state);

    return {
      state,
      events: [{ type: 'agent_created', agent: this.buildSnapshot(agentId, state) }],
    };
  }

  /**
   * Preámbulo común de Pre/PostToolUse: descarta eventos de la sesión
   * principal (sin agent_id) y de agentes ya terminales, materializa el
   * agente si hace falta, y deja `lastActivity` actualizado. Devuelve
   * null cuando el evento debe ignorarse; si no, el `events` ya trae el
   * agent_created del lazy-create (si aplicó) para preceder al resto.
   */
  private beginToolEvent(
    event: PreToolUseEvent | PostToolUseEvent,
  ): {
    agentId: string;
    events: DashboardEventToWebview[];
    nowMs: number;
    elapsedMs: number;
  } | null {
    if (!event.agent_id) return null;
    const { state, events } = this.ensureAgent(
      event.agent_id,
      event.cwd,
      event.session_id,
    );
    if (state.terminal) return null;

    const nowMs = this.now();
    state.lastActivityMs = nowMs;
    return {
      agentId: event.agent_id,
      events,
      nowMs,
      elapsedMs: nowMs - state.startedAtMs,
    };
  }

  private buildSnapshot(agentId: string, state: AgentState): AgentSnapshot {
    return {
      id: agentId,
      name: state.name,
      status: 'running',
      cwd: state.cwd,
      project: state.project,
      task: state.task,
      branch: state.branch,
      sessionId: state.sessionId,
      startedAtIso: new Date(state.startedAtMs).toISOString(),
      lastActivityIso: new Date(state.lastActivityMs).toISOString(),
      elapsedMs: 0,
      tokensUsed: 0,
      contextUsedPct: 0,
      transcriptPath: this.transcriptPathOf(state),
    };
  }
}

// === Funciones puras auxiliares ===

/**
 * Normaliza `Stop.background_tasks` a un set de agent_ids vivos. El
 * contrato no está congelado, así que es tolerante: acepta array de
 * strings (ids directos) o de objetos con `agent_id`/`id`/`task_id`.
 * Cualquier otra forma → set vacío (no excluye nada). Ante la duda NO
 * agrega un id (mejor reconciliar de más que dejar un muerto colgado).
 */
function backgroundTaskIds(raw: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(raw)) return ids;
  for (const item of raw) {
    if (typeof item === 'string') {
      ids.add(item);
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      for (const key of ['agent_id', 'id', 'task_id']) {
        if (typeof o[key] === 'string') ids.add(o[key] as string);
      }
    }
  }
  return ids;
}

function stringifyResult(resp: unknown): string {
  if (resp === undefined || resp === null) return '';
  if (typeof resp === 'string') return resp;
  try {
    return JSON.stringify(resp);
  } catch {
    return String(resp);
  }
}

/**
 * Heurística de error de un tool_response. Claude Code marca fallos con
 * `is_error: true` o un campo `error` no vacío. Conservador: ante la
 * duda, NO es error (un falso positivo pintaría rojo un tool exitoso).
 */
function detectToolError(resp: unknown): boolean {
  if (resp && typeof resp === 'object') {
    const r = resp as Record<string, unknown>;
    if (r.is_error === true) return true;
    if (typeof r.error === 'string' && r.error.length > 0) return true;
  }
  return false;
}
