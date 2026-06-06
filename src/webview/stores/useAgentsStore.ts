/* ================================================================
 * useAgentsStore.ts — Estado del dashboard.
 *
 * Pinia store que mantiene los agentes que el bridge del extension
 * host publica vía postMessage. Sin mock data: arranca vacío y se
 * hidrata con `agent_list` cuando el webview attache.
 *
 * Estilo: composition API (`defineStore('agents', () => {...})`)
 * para alinear con `<script setup>` de los componentes.
 *
 * Actions de mutación: las llama el composable
 * `useDashboardBridge` desde el handler de `window.message`. Los
 * componentes consumen los getters; nunca mutan el state directo.
 *
 * Lifecycle del proyecto (active / idle / inactive) se deriva en
 * runtime de los agentes — no viaja en el wire. Acá lo calculamos
 * con `Date.now()` cada vez que se computa el getter
 * `projectsByLifecycle`.
 * ================================================================ */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Agent, Project } from '../types';
import {
  LOG_RING_MAX,
  isTerminalStatus,
  type AgentCompletedResult,
  type AgentMetrics,
  type AgentSnapshot,
  type AgentStatus,
  type LogEntry,
  type TransportState,
} from '../../shared/dashboard-protocol';
import { useNow } from '../composables/useNow';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// Un agente `running` sin eventos de hook por más de esto se considera
// "sin actividad reciente" (stale). Heurística, NO terminal: el agente
// puede seguir vivo en una tool larga (build, test suite). El único
// "sigue vivo" que el viewer tiene es el próximo evento de hook, así que
// inferimos staleness por silencio. Hardcoded como TWENTY_FOUR_HOURS_MS
// (mismo patrón que el lifecycle de proyecto, sin setting).
const STALE_AFTER_MS = 90 * 1000;

export const useAgentsStore = defineStore('agents', () => {
  // === State ===

  /**
   * Lista plana de agentes recibidos del bridge. El orden es de
   * inserción (insertion-order del wire); los getters filtran y
   * ordenan a conveniencia de cada sección.
   */
  const agents = ref<Agent[]>([]);

  /**
   * Log streaming por agente. Bounded a 1000 entries (FIFO) para
   * que un agente verboso no haga crecer la memoria del webview
   * sin tope. Hoy nadie lo consume desde la UI (el detail panel
   * llega más adelante); persistimos para tenerlo listo.
   */
  const logsByAgent = ref<Record<string, LogEntry[]>>({});

  /**
   * Estado heurístico del transport MCP. El bridge lo emite con
   * `transport_state_changed` cuando un long-poll de `wait_for_agents`
   * lleva > 60s sin resolver (probable transport drop). El sidebar usa
   * esto para gatear un banner — visible solo si el setting
   * `claudeOrchestrator.showTransportState` está en true.
   */
  const transportState = ref<TransportState>('healthy');

  // === Actions de mutación (llamadas por useDashboardBridge) ===

  /**
   * Reemplaza el state completo con el snapshot recibido. Llamado
   * una vez por `agent_list` (hidratación inicial cuando attache
   * el webview).
   */
  function applyAgentList(list: AgentSnapshot[]): void {
    agents.value = list.map((a) => ({ ...a }));
    // Reset de logs en hidratación: el bridge va a re-emitir los
    // que correspondan via `agent_log` si fuera el caso (hoy no
    // hidrata logs).
    logsByAgent.value = {};
  }

  /** Push de un agente nuevo. */
  function addAgent(agent: AgentSnapshot): void {
    agents.value.push({ ...agent });
  }

  /**
   * Mutación parcial. `status` siempre llega; `metadata` puede
   * traer cualquier subset visible (currentTool, contextUsedPct,
   * tokensUsed, subtitle, elapsedMs). Object.assign hace merge sin
   * pisar campos no enviados.
   */
  function updateAgentStatus(
    agentId: string,
    status: AgentStatus,
    metadata?: Partial<AgentSnapshot>,
  ): void {
    const agent = agents.value.find((a) => a.id === agentId);
    if (!agent) return;
    // Reconciliación de resurrección: si el agente vuelve a un estado no
    // terminal (el bridge resucitó un huérfano ide_restart al recibir
    // eventos vivos), limpiamos los campos terminales que quedaron del
    // marcaje previo — si no, un agente `running` arrastraría reason +
    // completedAtIso del fallido aunque no se rendericen en la card.
    if (!isTerminalStatus(status) && isTerminalStatus(agent.status)) {
      agent.reason = undefined;
      agent.completedAtIso = undefined;
      agent.durationMs = undefined;
    }
    agent.status = status;
    if (metadata) {
      Object.assign(agent, metadata);
    }
  }

  /**
   * Append a un log per-agent con bound FIFO 1000. El detail panel
   * lo consume vía el getter `logsByAgent[agentId]`.
   *
   * Inicializamos UNA vez si no existe la key (entrega un nuevo
   * array) y después mutamos in-place con push/shift. Sin esto, el
   * patrón anterior `logsByAgent.value[agentId] = arr` re-asignaba
   * la key en cada entry, disparando el proxy `set` trap y
   * notificando consumidores aunque la referencia del array no
   * cambiara. Vue ya rastrea push/shift sobre el array reactivo.
   */
  function appendLog(agentId: string, entry: LogEntry): void {
    let arr = logsByAgent.value[agentId];
    if (!arr) {
      arr = [];
      logsByAgent.value[agentId] = arr;
    }
    arr.push(entry);
    if (arr.length > LOG_RING_MAX) {
      arr.shift();
    }
  }

  /**
   * Reemplaza el log per-agent con el ringbuffer hidratado del
   * bridge. Lo dispara el dispatcher cuando llega un
   * `agent_log_history` (el detail panel lo pide al montar). Los
   * entries vienen ya ordenados y bounded a 1000 del lado bridge,
   * así que no hace falta re-shiftear acá.
   */
  function replaceLogsForAgent(agentId: string, entries: LogEntry[]): void {
    logsByAgent.value[agentId] = entries.slice();
  }

  /** Setea el transportState con el último valor que emitió el bridge. */
  function setTransportState(state: TransportState): void {
    transportState.value = state;
  }

  /**
   * Mergea las métricas del transcript (modelo/tokens/context%) al
   * snapshot. Lo dispara `agent_metrics`, que el bridge emite al detail
   * panel cuando se hidrata. Object.assign sin pisar campos no enviados;
   * un parseo parcial (solo `model`, sin usage) actualiza lo que llegó y
   * deja el resto como estaba.
   */
  function applyMetrics(agentId: string, metrics: AgentMetrics): void {
    const agent = agents.value.find((a) => a.id === agentId);
    if (!agent) return;
    Object.assign(agent, metrics);
  }

  /**
   * Marca el agente como completado y aplica los campos
   * terminales (status final, duration, tokens, reason). Equivale
   * a un `agent_status_changed` final más explícito — el bridge
   * los emite por separado para que una UI futura pueda
   * diferenciarlos (ej. toast "agent done" solo en este evento).
   */
  function markAgentCompleted(agentId: string, result: AgentCompletedResult): void {
    const agent = agents.value.find((a) => a.id === agentId);
    if (!agent) return;
    agent.status = result.status;
    // durationMs opcional: no lo pisamos con undefined (no vimos el
    // arranque) — espejo del guard del bridge en applyCompleted.
    if (result.durationMs !== undefined) agent.durationMs = result.durationMs;
    agent.tokensUsed = result.tokensUsed;
    if (result.reason) agent.reason = result.reason;
    if (!agent.completedAtIso) {
      agent.completedAtIso = new Date().toISOString();
    }
  }

  // === Getters: secciones del dashboard ===

  const nowPlaying = computed<Agent[]>(() =>
    agents.value.filter((a) => a.status === 'running'),
  );

  const upNext = computed<Agent[]>(() =>
    agents.value.filter((a) => a.status === 'pending'),
  );

  /**
   * RECENT — agentes en estado terminal (done / failed / cancelled /
   * needs_review) ordenados por completed_at descendente. Usamos
   * `isTerminalStatus` (SSoT en shared/dashboard-protocol) para que
   * agregar un terminal nuevo no requiera tocar este filtro.
   *
   * `needs_review` es un estado terminal promovido por el orchestrator
   * (Mecanismo D auto-promociona si el agente declaró decisions/uncertainties
   * en su exit report; Mecanismo A promociona si el critic Haiku emitió
   * flags). Visualmente ocupa RECENT igual que done/failed/cancelled
   * pero con stripe naranja + icon eye + badge ⚠ Flagged.
   */
  const recent = computed<Agent[]>(() =>
    agents.value
      .filter((a) => isTerminalStatus(a.status))
      .sort((a, b) => {
        const aIso = a.completedAtIso ?? '';
        const bIso = b.completedAtIso ?? '';
        return bIso.localeCompare(aIso);
      }),
  );

  /**
   * Cantidad de failed en las últimas 24h. Alimenta el FailedBadge
   * del section header de RECENT — solo se renderiza si > 0.
   *
   * Iteramos `agents.value` directo (no `recent.value`) para que
   * el conteo NO dependa del orden visual.
   */
  const recentFailedCount = computed<number>(() => {
    const now = Date.now();
    return agents.value.filter((a) => {
      if (a.status !== 'failed') return false;
      if (!a.completedAtIso) return false;
      // Guard contra ISO inválido: Date.parse devuelve NaN y
      // `NaN < threshold` siempre es false → excluiría el item
      // por la rama equivocada. Mejor explícito.
      const completedMs = Date.parse(a.completedAtIso);
      if (!Number.isFinite(completedMs)) return false;
      return now - completedMs < TWENTY_FOUR_HOURS_MS;
    }).length;
  });

  /**
   * Proyectos derivados de los agentes en memoria (no hay tabla
   * separada — el wire no manda proyectos, solo agentes). Cada
   * proyecto único saca su lifecycle del set de agentes que lo
   * tienen:
   *   - active: 1+ running/pending.
   *   - idle: solo recent con completed_at más reciente <24h.
   *   - inactive: solo recent con completed_at más viejo ≥24h.
   *
   * Cuando no hay agentes, retorna 3 listas vacías — la UI muestra
   * empty state.
   */
  // El tick global (useNow, 1s) actúa como reloj reactivo: sin
  // él, un proyecto que entra como `idle` (recent <24h) NUNCA se
  // re-clasifica a `inactive` hasta que llegue un evento nuevo
  // del bridge (que con un agente terminado podría no llegar
  // nunca). Conectando el computed a useNow, cada tick fuerza
  // recálculo y el lifecycle progresa solo. El cómputo es barato
  // (filter + sort sobre tens of agents) y el computed solo se
  // recomputa si tiene observers — los dropdowns cerrados no
  // pagan costo.
  const now = useNow();

  /**
   * Ids de agentes `running` que llevan más de STALE_AFTER_MS sin un
   * evento de hook. Lo consumen las cards running para pintar "sin
   * actividad reciente" sin sacar al agente de NOW PLAYING. Reactivo al
   * tick de useNow → un agente cruza el umbral solo, sin esperar un
   * evento del bridge (que con un agente callado podría no llegar).
   *
   * Fallback a startedAtIso si el wire no trae lastActivityIso (snapshot
   * viejo persistido antes de F3). Guard Number.isFinite: un ISO basura
   * no debe marcar stale por la rama equivocada.
   */
  const staleAgentIds = computed<Set<string>>(() => {
    void now.value;
    const nowMs = Date.now();
    const ids = new Set<string>();
    for (const a of agents.value) {
      if (a.status !== 'running') continue;
      const lastIso = a.lastActivityIso ?? a.startedAtIso;
      if (!lastIso) continue;
      const lastMs = Date.parse(lastIso);
      if (!Number.isFinite(lastMs)) continue;
      if (nowMs - lastMs > STALE_AFTER_MS) ids.add(a.id);
    }
    return ids;
  });

  const projectsByLifecycle = computed(() => {
    // Leemos now.value para que Vue cree la dependencia reactiva
    // con el tick — aunque no usemos directamente la variable
    // (Date.now() ya da el momento real abajo). Sin esta lectura
    // el computed nunca se invalida por tiempo.
    void now.value;
    const byLifecycle = {
      active: [] as Project[],
      idle: [] as Project[],
      inactive: [] as Project[],
    };
    if (agents.value.length === 0) return byLifecycle;

    const nowMs = Date.now();
    // Agrupar agentes por project.
    const byProject = new Map<string, Agent[]>();
    for (const a of agents.value) {
      const list = byProject.get(a.project) ?? [];
      list.push(a);
      byProject.set(a.project, list);
    }

    // Derivar lifecycle + meta por proyecto.
    for (const [projectName, list] of byProject) {
      const hasActive = list.some(
        (a) => a.status === 'running' || a.status === 'pending',
      );

      let lifecycle: Project['lifecycle'];
      let lastUpdateIso = '';
      let activeTask: string | null = null;

      if (hasActive) {
        lifecycle = 'active';
        // task de un running/pending (si hay una sola, la mostramos).
        const activeAgents = list.filter(
          (a) => a.status === 'running' || a.status === 'pending',
        );
        const tasks = new Set(activeAgents.map((a) => a.task).filter(Boolean));
        activeTask = tasks.size === 1 ? [...tasks][0] : null;
        // lastUpdate = max(startedAtIso) de los running.
        lastUpdateIso = activeAgents
          .map((a) => a.startedAtIso ?? '')
          .filter(Boolean)
          .sort()
          .pop() ?? '';
      } else {
        // Solo recent. lifecycle por edad del más reciente completed_at.
        const completedAts = list
          .map((a) => a.completedAtIso ?? '')
          .filter(Boolean)
          .sort();
        const latest = completedAts[completedAts.length - 1] ?? '';
        lastUpdateIso = latest;
        // Si latest es vacío o no parsea, lo tratamos como
        // proyecto sin update reciente → inactive. Sin el guard
        // `Number.isFinite`, un ISO basura caería como NaN y la
        // comparación marcaría todo inactive por la rama
        // equivocada (NaN < n = false). Explícito es mejor.
        const latestMs = latest ? Date.parse(latest) : NaN;
        const ageMs = Number.isFinite(latestMs) ? nowMs - latestMs : Infinity;
        lifecycle = ageMs < TWENTY_FOUR_HOURS_MS ? 'idle' : 'inactive';
        // task del más reciente recent.
        const lastAgent = list
          .filter((a) => a.completedAtIso === latest)
          .at(0);
        activeTask = lastAgent?.task || null;
      }

      // id derivado del nombre — los componentes lo usan como key
      // estable mientras el nombre no cambie. Si el wire en algún
      // momento manda un projectId propio, se respeta y este
      // fallback queda.
      const project: Project = {
        id: `p-${projectName}`,
        name: projectName,
        lifecycle,
        lastUpdateIso,
        activeTask,
      };
      byLifecycle[lifecycle].push(project);
    }

    for (const key of ['active', 'idle', 'inactive'] as const) {
      byLifecycle[key].sort((a, b) => a.name.localeCompare(b.name));
    }
    return byLifecycle;
  });

  /**
   * Conteo total de agentes (cualquier sección). Útil para el
   * empty state global ("No agents yet" cuando == 0).
   */
  const totalCount = computed<number>(() => agents.value.length);

  /**
   * Lista plana de todos los proyectos (todos los lifecycles
   * concatenados). Lo consumen componentes que necesitan iterar
   * proyectos sin importarles el lifecycle (ej. el ProjectSelector
   * que busca por id para pintar el trigger). Mantener este getter
   * derivado del agrupado evita doble cálculo en runtime.
   */
  const projects = computed<Project[]>(() => {
    const grouped = projectsByLifecycle.value;
    return [...grouped.active, ...grouped.idle, ...grouped.inactive];
  });

  return {
    // state
    agents,
    logsByAgent,
    transportState,
    // actions
    applyAgentList,
    addAgent,
    updateAgentStatus,
    appendLog,
    replaceLogsForAgent,
    markAgentCompleted,
    setTransportState,
    applyMetrics,
    // getters
    nowPlaying,
    upNext,
    recent,
    recentFailedCount,
    staleAgentIds,
    projectsByLifecycle,
    projects,
    totalCount,
  };
});
