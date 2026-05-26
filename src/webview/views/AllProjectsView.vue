<script setup lang="ts">
/**
 * AllProjectsView — vista global del dashboard (modo default, sin
 * filtro de proyecto).
 *
 * Layout del body (KANBAN_DESIGN_BRIEF §4.1):
 *
 *   ├── NOW PLAYING (3) ──────────────────────┤
 *   │ <ProjectGroup A>                        │
 *   │ <ProjectGroup B>                        │
 *   ├── UP NEXT (3) ──────────────────────────┤
 *   │ <ProjectGroup C>                        │
 *   │ <ProjectGroup D>                        │
 *   │ <ProjectGroup E>                        │
 *   ├── RECENT (12) 1 FAILED   ▶  (colapsada) │
 *
 * La Toolbar (title + selector + context line) vive en App.vue y se
 * comparte con SingleProjectView, así que NO la renderizamos acá.
 *
 *   - NOW PLAYING y UP NEXT arrancan expandidas; RECENT colapsada
 *     (volumen global puede ser grande, mejor diferir la pintada).
 *   - RECENT colapsado significa que NO renderizamos AgentCardRecent —
 *     basta con el counter (12) y el FailedBadge "1 FAILED" en rojo
 *     del header.
 *
 * La agrupación de NOW/UP por (project + task + branch + batchId) se
 * hace inline acá; el bloque son ~12 líneas y extraer a composable
 * sería abstracción especulativa para un solo call site.
 */

import { computed, ref } from 'vue';
import { useAgentsStore } from '../stores/useAgentsStore';
import type { Agent } from '../types';
import SectionHeader from '../components/sections/SectionHeader.vue';
import ProjectGroup from '../components/sections/ProjectGroup.vue';
import ProjectGroupHeader from '../components/sections/ProjectGroupHeader.vue';
import AgentCardRunning from '../components/cards/AgentCardRunning.vue';
import AgentCardPending from '../components/cards/AgentCardPending.vue';
import AgentCardRecent from '../components/cards/AgentCardRecent.vue';

const store = useAgentsStore();

// === Estado de colapso por sección ===
//
// 3 refs locales en vez de moverlos al store: son UI-only, no
// persisten entre reloads, y no los consume nadie más.

const nowPlayingOpen = ref(true);
const upNextOpen = ref(true);
const recentOpen = ref(false);

// === Helper de grouping (inline) ===
//
// Agrupa una lista de agentes en buckets por la clave
// `project|task|branch|batchId`. Mantiene el orden de la primera
// aparición de cada clave para que el render sea estable.
//
// Devuelve `Array<{ key, project, task, branch, agents }>` para que
// el v-for use el key estable y los project group headers tomen los
// 3 strings de un solo lugar.

interface GroupedAgents {
  key: string;
  project: string;
  task: string;
  branch: string;
  agents: Agent[];
}

function groupAgents(agents: Agent[]): GroupedAgents[] {
  const byKey = new Map<string, GroupedAgents>();
  for (const agent of agents) {
    const key = `${agent.project}|${agent.task}|${agent.branch}|${agent.batchId}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        project: agent.project,
        task: agent.task,
        branch: agent.branch,
        agents: [],
      };
      byKey.set(key, group);
    }
    group.agents.push(agent);
  }
  return Array.from(byKey.values());
}

const nowPlayingGroups = computed(() => groupAgents(store.nowPlaying));
const upNextGroups = computed(() => groupAgents(store.upNext));
const recentGroups = computed(() => groupAgents(store.recent));
</script>

<template>
  <div class="dashboard">
    <!-- ============================================================
         === NOW PLAYING ===
         ============================================================ -->
    <SectionHeader
      kind="NOW PLAYING"
      :count="store.nowPlaying.length"
      :expanded="nowPlayingOpen"
      @toggle="nowPlayingOpen = !nowPlayingOpen"
    />
    <div v-if="nowPlayingOpen" class="section-body">
      <ProjectGroup v-for="group in nowPlayingGroups" :key="group.key">
        <template #header>
          <ProjectGroupHeader
            :project="group.project"
            :task="group.task"
            :branch="group.branch"
          />
        </template>
        <AgentCardRunning
          v-for="agent in group.agents"
          :key="agent.id"
          :agent="agent"
        />
      </ProjectGroup>
    </div>

    <!-- ============================================================
         === UP NEXT ===
         Cada project group lleva 1 agente en la mock data, pero el
         :index="i + 1" deja la puerta abierta a múltiples agentes
         pendientes por grupo cuando entre la data real.
         ============================================================ -->
    <SectionHeader
      kind="UP NEXT"
      :count="store.upNext.length"
      :expanded="upNextOpen"
      @toggle="upNextOpen = !upNextOpen"
    />
    <div v-if="upNextOpen" class="section-body">
      <ProjectGroup v-for="group in upNextGroups" :key="group.key">
        <template #header>
          <ProjectGroupHeader
            :project="group.project"
            :task="group.task"
            :branch="group.branch"
          />
        </template>
        <AgentCardPending
          v-for="(agent, i) in group.agents"
          :key="agent.id"
          :agent="agent"
          :index="i + 1"
        />
      </ProjectGroup>
    </div>

    <!-- ============================================================
         === RECENT ===
         Colapsada por default. Al expandir renderiza los recent
         agrupados por project group (mismo patrón que NOW/UP).
         ============================================================ -->
    <SectionHeader
      kind="RECENT"
      :count="store.recent.length"
      :failed-count="store.recentFailedCount"
      :expanded="recentOpen"
      @toggle="recentOpen = !recentOpen"
    />
    <div v-if="recentOpen" class="section-body">
      <ProjectGroup v-for="group in recentGroups" :key="group.key">
        <template #header>
          <ProjectGroupHeader
            :project="group.project"
            :task="group.task"
            :branch="group.branch"
          />
        </template>
        <AgentCardRecent
          v-for="agent in group.agents"
          :key="agent.id"
          :agent="agent"
        />
      </ProjectGroup>
    </div>
  </div>
</template>

<style scoped>
/* === Container — column con gap consistente entre secciones === */
.dashboard {
  display: flex;
  flex-direction: column;
  /* No usamos gap entre el body de sección y el siguiente header,
   * porque el border-top del header ya da la separación visual. */
}

/* ===========================================================
   === Section body — wrapper de los project groups        ===
   Padding lateral 12px + gap 8px entre groups (HANDOFF §14). ===
   =========================================================== */
.section-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px 12px;
}
</style>
