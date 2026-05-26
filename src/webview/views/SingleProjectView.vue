<script setup lang="ts">
/**
 * SingleProjectView — vista filtrada a un solo proyecto (HANDOFF
 * §5.2, KANBAN_DESIGN_BRIEF §4.2).
 *
 * Diferencias con AllProjectsView:
 *
 *   - Los agentes vienen filtrados por `selectedProjectId` del
 *     composable useProjectFilter.
 *   - NO hay project group containers. Cada agent card es full-width
 *     y se renderiza con las variantes *Standalone (card propio).
 *   - RECENT arranca expandida por default (el volumen filtrado ya
 *     es manejable, vs. la vista global donde se acumulan 12+).
 *   - La toolbar (con el selector) NO vive acá: vive en App.vue para
 *     que se comparta con AllProjectsView.
 *
 * El filter lo aplica el store inline acá — un .filter() de 2 líneas
 * no vale composable. Si la lógica de matching del project se vuelve
 * compleja (ej. matching por id en vez de name cuando el wire mande
 * ambos), se promueve a getter del store.
 */

import { computed, ref } from 'vue';
import { useAgentsStore } from '../stores/useAgentsStore';
import { useProjectFilter } from '../composables/useProjectFilter';
import SectionHeader from '../components/sections/SectionHeader.vue';
import AgentCardRunningStandalone from '../components/cards/AgentCardRunningStandalone.vue';
import AgentCardPendingStandalone from '../components/cards/AgentCardPendingStandalone.vue';
import AgentCardRecent from '../components/cards/AgentCardRecent.vue';

const store = useAgentsStore();
const { selectedProjectId } = useProjectFilter();

// === Resolver projectName desde el id ===
//
// Los agentes mock guardan `project` como string name (no id). El
// composable trabaja con id (porque eso es lo que clickea el user
// en el selector). Acá resolvemos uno desde el otro para filtrar.

const projectName = computed<string | null>(() => {
  if (!selectedProjectId.value) return null;
  return (
    store.projects.find((p) => p.id === selectedProjectId.value)?.name ?? null
  );
});

// === Agentes filtrados por sección ===

const runningAgents = computed(() =>
  store.nowPlaying.filter((a) => a.project === projectName.value),
);

const pendingAgents = computed(() =>
  store.upNext.filter((a) => a.project === projectName.value),
);

const recentAgents = computed(() =>
  store.recent.filter((a) => a.project === projectName.value),
);

// === Estado de colapso por sección ===
//
// RECENT arranca EXPANDIDA acá (vs. colapsada en All projects)
// porque el volumen filtrado a 1 proyecto siempre es manejable.

const nowPlayingOpen = ref(true);
const upNextOpen = ref(true);
const recentOpen = ref(true);
</script>

<template>
  <div class="dashboard">
    <!-- ============================================================
         === NOW PLAYING ===
         Cards standalone full-width, sin project group container.
         ============================================================ -->
    <SectionHeader
      kind="NOW PLAYING"
      :count="runningAgents.length"
      :expanded="nowPlayingOpen"
      @toggle="nowPlayingOpen = !nowPlayingOpen"
    />
    <div v-if="nowPlayingOpen" class="section-body">
      <AgentCardRunningStandalone
        v-for="agent in runningAgents"
        :key="agent.id"
        :agent="agent"
      />
    </div>

    <!-- ============================================================
         === UP NEXT ===
         ============================================================ -->
    <SectionHeader
      kind="UP NEXT"
      :count="pendingAgents.length"
      :expanded="upNextOpen"
      @toggle="upNextOpen = !upNextOpen"
    />
    <div v-if="upNextOpen" class="section-body">
      <AgentCardPendingStandalone
        v-for="(agent, i) in pendingAgents"
        :key="agent.id"
        :agent="agent"
        :index="i + 1"
      />
    </div>

    <!-- ============================================================
         === RECENT (expandida por default acá) ===
         Lista plana de AgentCardRecent — sin project group container
         porque ya estamos en single project, el agrupamiento sería
         redundante.
         ============================================================ -->
    <SectionHeader
      kind="RECENT"
      :count="recentAgents.length"
      :expanded="recentOpen"
      @toggle="recentOpen = !recentOpen"
    />
    <div v-if="recentOpen" class="section-body">
      <AgentCardRecent
        v-for="agent in recentAgents"
        :key="agent.id"
        :agent="agent"
      />
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
}

/* Mismo padding lateral + gap que AllProjectsView para que la
 * transición entre vistas no parpadee. */
.section-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px 12px;
}
</style>
