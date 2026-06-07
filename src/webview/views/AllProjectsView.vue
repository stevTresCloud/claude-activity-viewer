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
 * La agrupación de NOW/UP/RECENT por (project + sessionId + cwd)
 * se delega a `groupAgents` del store (función pura exportada).
 */

import { computed, ref } from 'vue';
import { useAgentsStore, groupAgents } from '../stores/useAgentsStore';
import SectionHeader from '../components/sections/SectionHeader.vue';
import ProjectGroup from '../components/sections/ProjectGroup.vue';
import ProjectGroupHeader from '../components/sections/ProjectGroupHeader.vue';
import AgentCardRunning from '../components/cards/AgentCardRunning.vue';
import AgentCardPending from '../components/cards/AgentCardPending.vue';
import AgentCardRecent from '../components/cards/AgentCardRecent.vue';

const store = useAgentsStore();

// === Discoverability hint cuando dashboard está vacío ===
//
// El hint aparece al fondo cuando totalCount=0 (primer install o
// recién después de un Rescan que limpió RECENT). Las 3 secciones se
// ven siempre y el hint queda discreto al final, explicando cómo
// spawnar agentes desde el chat de Claude Code.

const isDashboardEmpty = computed(() => store.totalCount === 0);

// === Estado de colapso por sección ===
//
// 3 refs locales en vez de moverlos al store: son UI-only, no
// persisten entre reloads, y no los consume nadie más.

const nowPlayingOpen = ref(true);
const upNextOpen = ref(true);
const recentOpen = ref(false);

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
            :session-id="group.sessionId"
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
            :session-id="group.sessionId"
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
            :session-id="group.sessionId"
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

    <!-- ============================================================
         === Empty hint con CTA ===
         Solo cuando dashboard está totalmente vacío. Las 3 secciones
         siguen visibles arriba con counter (0); este bloque ofrece
         un próximo paso accionable sin obligar al user a buscar el
         comando palette.
         ============================================================ -->
    <div v-if="isDashboardEmpty" class="empty-hint">
      <p class="empty-hint-title">No agents yet.</p>
      <p class="empty-hint-msg">
        Spawn agents from your Claude Code chat with the
        <code>spawn_agents</code> tool.
      </p>
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

/* ===========================================================
   === Empty hint                                          ===
   Aparece al final cuando totalCount=0. Diseño minimal:
   título + mensaje pequeño. NO compite visualmente con las
   secciones del kanban (más arriba).                        ===
   =========================================================== */
.empty-hint {
  padding: 24px 16px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border);
  margin-top: 8px;
}

.empty-hint-title {
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 500;
  color: var(--foreground);
}

.empty-hint-msg {
  font-family: var(--font-ui);
  font-size: 11px;
  color: var(--foreground-muted);
  line-height: 1.5;
  margin: 0;
}

.empty-hint-msg code {
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  background: var(--background-hover);
  padding: 1px 4px;
  border-radius: 3px;
}

</style>
