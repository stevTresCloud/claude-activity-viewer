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
} from '../../shared/dashboard-protocol';
import { useNow } from '../composables/useNow';
import { UNKNOWN_SESSION } from '../../shared/format';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// Un agente `running` sin eventos de hook por más de esto se considera
// "sin actividad reciente" (stale). Heurística, NO terminal: el agente
// puede seguir vivo en una tool larga (build, test suite). El único
// "sigue vivo" que el viewer tiene es el próximo evento de hook, así que
// inferimos staleness por silencio.
const STALE_AFTER_MS = 90 * 1000;

// === Agrupación de agentes vivos ===

/**
 * Grupo de agentes que comparten project + sessionId + cwd. Es la
 * unidad visual de ProjectGroup en NOW PLAYING y UP NEXT.
 *
 * `sessionId` cae a `'unknown'` cuando el agente no trae sessionId
 * todavía (lazy-created antes de que el hook lo proveyera).
 */
export interface GroupedAgents {
  key: string;
  project: string;
  /** sessionId corto para display (o 'unknown'). */
  sessionId: string;
  branch: string;
  cwd: string;
  agents: Agent[];
}

/**
 * Agrupa una lista de agentes por `project|sessionId|cwd`. Mantiene
 * el orden de primera aparición de cada grupo para render estable.
 * Exportada como función pura (no getter reactivo) para que los tests
 * puedan ejercitarla sin levantar Pinia.
 */
export function groupAgents(agents: Agent[]): GroupedAgents[] {
  const byKey = new Map<string, GroupedAgents>();
  for (const agent of agents) {
    // `||` (no `??`): un sessionId '' (válido per el schema zod optional)
    // debe caer al sentinel, no producir una clave/​header en blanco.
    const sid = agent.sessionId || UNKNOWN_SESSION;
    const cwd = agent.cwd ?? '';
    const key = `${agent.project}|${sid}|${cwd}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        project: agent.project,
        sessionId: sid,
        branch: agent.branch,
        cwd,
        agents: [],
      };
      byKey.set(key, group);
    }
    group.agents.push(agent);
  }
  return Array.from(byKey.values());
}

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
   * sin tope.
   */
  const logsByAgent = ref<Record<string, LogEntry[]>>({});

  // === Actions de mutación (llamadas por useDashboardBridge) ===

  /**
   * Reemplaza el state completo con el snapshot recibido. Llamado
   * una vez por `agent_list` (hidratación inicial cuando attache
   * el webview).
   */
  function applyAgentList(list: AgentSnapshot[]): void {
    agents.value = list.map((a) => ({ ...a }));
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
   * `agent_log_history` (el detail panel lo pide al montar).
   */
  function replaceLogsForAgent(agentId: string, entries: LogEntry[]): void {
    logsByAgent.value[agentId] = entries.slice();
  }

  /**
   * Mergea las métricas del transcript (modelo/tokens/context%) al
   * snapshot. Lo dispara `agent_metrics`, que el bridge emite al detail
   * panel cuando se hidrata.
   */
  function applyMetrics(agentId: string, metrics: AgentMetrics): void {
    const agent = agents.value.find((a) => a.id === agentId);
    if (!agent) return;
    Object.assign(agent, metrics);
  }

  /**
   * Marca el agente como completado y aplica los campos terminales
   * (status final, duration, tokens, reason).
   */
  function markAgentCompleted(agentId: string, result: AgentCompletedResult): void {
    const agent = agents.value.find((a) => a.id === agentId);
    if (!agent) return;
    agent.status = result.status;
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
   * RECENT — agentes en estado terminal (done / failed / cancelled)
   * ordenados por completed_at descendente.
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
   * del section header de RECENT.
   */
  const recentFailedCount = computed<number>(() => {
    const now = Date.now();
    return agents.value.filter((a) => {
      if (a.status !== 'failed') return false;
      if (!a.completedAtIso) return false;
      const completedMs = Date.parse(a.completedAtIso);
      if (!Number.isFinite(completedMs)) return false;
      return now - completedMs < TWENTY_FOUR_HOURS_MS;
    }).length;
  });

  // El tick global (useNow, 1s) actúa como reloj reactivo.
  const now = useNow();

  /**
   * Ids de agentes `running` que llevan más de STALE_AFTER_MS sin un
   * evento de hook. Lo consumen las cards running para pintar "sin
   * actividad reciente".
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
    void now.value;
    const byLifecycle = {
      active: [] as Project[],
      idle: [] as Project[],
      inactive: [] as Project[],
    };
    if (agents.value.length === 0) return byLifecycle;

    const nowMs = Date.now();
    const byProject = new Map<string, Agent[]>();
    for (const a of agents.value) {
      const list = byProject.get(a.project) ?? [];
      list.push(a);
      byProject.set(a.project, list);
    }

    for (const [projectName, list] of byProject) {
      const hasActive = list.some(
        (a) => a.status === 'running' || a.status === 'pending',
      );

      let lifecycle: Project['lifecycle'];
      let lastUpdateIso = '';
      let activeTask: string | null = null;

      if (hasActive) {
        lifecycle = 'active';
        const activeAgents = list.filter(
          (a) => a.status === 'running' || a.status === 'pending',
        );
        const tasks = new Set(activeAgents.map((a) => a.task).filter(Boolean));
        activeTask = tasks.size === 1 ? [...tasks][0] : null;
        lastUpdateIso = activeAgents
          .map((a) => a.startedAtIso ?? '')
          .filter(Boolean)
          .sort()
          .pop() ?? '';
      } else {
        const completedAts = list
          .map((a) => a.completedAtIso ?? '')
          .filter(Boolean)
          .sort();
        const latest = completedAts[completedAts.length - 1] ?? '';
        lastUpdateIso = latest;
        const latestMs = latest ? Date.parse(latest) : NaN;
        const ageMs = Number.isFinite(latestMs) ? nowMs - latestMs : Infinity;
        lifecycle = ageMs < TWENTY_FOUR_HOURS_MS ? 'idle' : 'inactive';
        const lastAgent = list
          .filter((a) => a.completedAtIso === latest)
          .at(0);
        activeTask = lastAgent?.task || null;
      }

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

  /** Conteo total de agentes (cualquier sección). */
  const totalCount = computed<number>(() => agents.value.length);

  /**
   * Lista plana de todos los proyectos (todos los lifecycles
   * concatenados). Lo consumen componentes que necesitan iterar
   * proyectos sin importarles el lifecycle.
   */
  const projects = computed<Project[]>(() => {
    const grouped = projectsByLifecycle.value;
    return [...grouped.active, ...grouped.idle, ...grouped.inactive];
  });

  return {
    // state
    agents,
    logsByAgent,
    // actions
    applyAgentList,
    addAgent,
    updateAgentStatus,
    appendLog,
    replaceLogsForAgent,
    markAgentCompleted,
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
