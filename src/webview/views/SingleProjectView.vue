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

import { computed, ref, watch } from 'vue';
import { useAgentsStore } from '../stores/useAgentsStore';
import { useScannerStore } from '../stores/useScannerStore';
import { useProjectFilter } from '../composables/useProjectFilter';
import { resolveProjectName } from '../composables/resolveProjectName';
import SectionHeader from '../components/sections/SectionHeader.vue';
import AgentCardRunningStandalone from '../components/cards/AgentCardRunningStandalone.vue';
import AgentCardPendingStandalone from '../components/cards/AgentCardPendingStandalone.vue';
import AgentCardRecent from '../components/cards/AgentCardRecent.vue';
import SessionCard from '../components/cards/SessionCard.vue';

const store = useAgentsStore();
const scanner = useScannerStore();
const { selectedProjectId } = useProjectFilter();

// === Resolver projectName desde el id ===
//
// Los agentes mock guardan `project` como string name (no id). El
// composable trabaja con id (porque eso es lo que clickea el user
// en el selector). Acá resolvemos uno desde el otro para filtrar.

const projectName = computed<string | null>(() =>
  resolveProjectName(selectedProjectId.value, store.projects),
);

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

// === PAST SESSIONS: sesiones históricas del proyecto ===
//
// Dedup contra agentes vivos: pasamos los sessionIds de agentes
// running/pending para que el getter excluya sdk-ts duplicadas.
// Las `claude-vscode` siempre aparecen aunque coincida sessionId
// (chats abiertos por el user, no por orchestrator).

const liveSessionIds = computed<Set<string>>(() => {
  const ids = new Set<string>();
  for (const a of store.agents) {
    if (a.sessionId && (a.status === 'running' || a.status === 'pending')) {
      ids.add(a.sessionId);
    }
  }
  return ids;
});

const pastSessions = computed(() => {
  if (!projectName.value) return [];
  return scanner.pastSessionsForProject(projectName.value, liveSessionIds.value);
});

/**
 * Vista vacía total: el user clickeó un proyecto que no tiene
 * agentes vivos ni sesiones históricas. Pasa típicamente con
 * proyectos solo-disco (subfolder descubierto por el scanner) que
 * el user nunca ha tocado con Claude Code.
 *
 * Sin este flag la vista renderea 3 SectionHeader vacíos y el
 * user no sabe si rompió algo o si está OK que no haya nada.
 */
const isEmpty = computed(
  () =>
    runningAgents.value.length === 0 &&
    pendingAgents.value.length === 0 &&
    recentAgents.value.length === 0 &&
    pastSessions.value.length === 0,
);

// === Estado de colapso por sección ===
//
// RECENT arranca EXPANDIDA acá (vs. colapsada en All projects)
// porque el volumen filtrado a 1 proyecto siempre es manejable.
// PAST SESSIONS arranca COLAPSADA cuando hay muchas (>3) para no
// empujar el resto bajo el fold; con pocas, expandida es OK.
//
// PAST SESSIONS: el ref de apertura se reevalúa al cambiar de
// proyecto (el composable de filter es singleton de módulo, así
// que el componente no se desmonta entre proyectos). Sin el watch
// quedaría con el valor del setup inicial (típicamente 'all
// projects' → 0 sesiones → true) aunque el nuevo proyecto tenga
// 50 sesiones.

const nowPlayingOpen = ref(true);
const upNextOpen = ref(true);
const recentOpen = ref(true);
const pastSessionsOpen = ref(true);
/**
 * Toggle visual de PAST SESSIONS: false = una línea con ellipsis,
 * true = hasta 3 líneas con line-clamp. Lo controla un botón en
 * el header de la sección. Default false porque para muchas
 * sesiones la lista compacta es más navegable.
 */
const pastSessionsExpanded = ref(false);
watch(
  () => [projectName.value, pastSessions.value.length] as const,
  ([, count], oldVal) => {
    // Solo reseteamos cuando cambia el proyecto. Si el user ya
    // toggleó manualmente dentro del mismo proyecto y solo cambia
    // el count (porque entró un scan nuevo), respetamos su elección.
    const projectChanged = !oldVal || oldVal[0] !== projectName.value;
    if (projectChanged) {
      pastSessionsOpen.value = count <= 3;
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="dashboard">
    <!-- ============================================================
         === Empty state ===
         Proyecto sin actividad ni historial: render explícito para
         que el user sepa que no rompió nada (vs. una vista en
         blanco que parece bug).
         ============================================================ -->
    <div v-if="isEmpty" class="empty-state">
      <i class="codicon codicon-folder empty-icon" />
      <p class="empty-title">{{ projectName }}</p>
      <p class="empty-msg">No agents or past sessions for this project yet.</p>
      <p class="empty-hint">Launch an agent via the MCP tool, or open Claude Code in this folder to populate sessions.</p>
    </div>

    <!-- ============================================================
         === NOW PLAYING ===
         Cards standalone full-width, sin project group container.
         ============================================================ -->
    <SectionHeader
      v-if="!isEmpty"
      kind="NOW PLAYING"
      :count="runningAgents.length"
      :expanded="nowPlayingOpen"
      @toggle="nowPlayingOpen = !nowPlayingOpen"
    />
    <div v-if="!isEmpty && nowPlayingOpen" class="section-body">
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
      v-if="!isEmpty"
      kind="UP NEXT"
      :count="pendingAgents.length"
      :expanded="upNextOpen"
      @toggle="upNextOpen = !upNextOpen"
    />
    <div v-if="!isEmpty && upNextOpen" class="section-body">
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
      v-if="!isEmpty"
      kind="RECENT"
      :count="recentAgents.length"
      :expanded="recentOpen"
      @toggle="recentOpen = !recentOpen"
    />
    <div v-if="!isEmpty && recentOpen" class="section-body">
      <AgentCardRecent
        v-for="agent in recentAgents"
        :key="agent.id"
        :agent="agent"
      />
    </div>

    <!-- ============================================================
         === PAST SESSIONS ===
         Sesiones históricas del proyecto leídas de
         ~/.claude/projects/. Sin agentes vivos las muestra todas;
         con vivos descuenta solo las sdk-ts duplicadas.
         La sección se OCULTA cuando no hay nada (no inflar la
         vista de un proyecto sin historial).
         ============================================================ -->
    <template v-if="!isEmpty && pastSessions.length > 0">
      <div class="past-sessions-header">
        <SectionHeader
          kind="PAST SESSIONS"
          :count="pastSessions.length"
          :expanded="pastSessionsOpen"
          @toggle="pastSessionsOpen = !pastSessionsOpen"
        />
        <!-- Toggle compacto al lado del header: 1-línea vs 3-líneas.
             Visible solo cuando la sección está abierta — no tiene
             sentido controlar layout de cards colapsadas. -->
        <button
          v-if="pastSessionsOpen"
          type="button"
          class="cards-expand-btn"
          :class="{ 'is-active': pastSessionsExpanded }"
          :title="pastSessionsExpanded ? 'Collapse cards' : 'Expand cards (show more lines)'"
          aria-label="Toggle card expansion"
          @click="pastSessionsExpanded = !pastSessionsExpanded"
        >
          <i
            class="codicon"
            :class="pastSessionsExpanded ? 'codicon-fold' : 'codicon-unfold'"
          />
        </button>
      </div>
      <div v-if="pastSessionsOpen" class="section-body">
        <SessionCard
          v-for="session in pastSessions"
          :key="session.filePath"
          :session="session"
          :expanded="pastSessionsExpanded"
        />
      </div>
    </template>
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

/* === PAST SESSIONS header con botón expand al lado === */
/* El SectionHeader es full-width y clickable; el botón vive en un
 * wrapper que lo deja ocupar todo menos el ancho fijo del botón. */
.past-sessions-header {
  display: flex;
  align-items: center;
  position: relative;
}
.past-sessions-header :deep(.section-header) {
  flex: 1;
  /* Reserva espacio para el botón flotante a la derecha. */
  padding-right: 36px;
}
.cards-expand-btn {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--foreground);
  opacity: 0.6;
  border-radius: 4px;
  cursor: pointer;
}
.cards-expand-btn:hover {
  background: rgb(255 255 255 / 0.06);
  opacity: 1;
}
.cards-expand-btn.is-active {
  opacity: 1;
  color: var(--focus-ring);
}
.cards-expand-btn .codicon {
  font-size: 13px;
}

/* === Empty state — proyecto sin actividad ni historial === */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 32px 16px;
  text-align: center;
  color: var(--foreground-muted);
}
.empty-icon {
  font-size: 28px;
  opacity: 0.5;
  margin-bottom: 4px;
}
.empty-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
}
.empty-msg {
  margin: 0;
  font-size: 11px;
}
.empty-hint {
  margin: 4px 0 0;
  font-size: 10px;
  opacity: 0.7;
  max-width: 260px;
  line-height: 1.4;
}
</style>
