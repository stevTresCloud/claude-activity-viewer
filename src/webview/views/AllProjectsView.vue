<script setup lang="ts">
/**
 * AllProjectsView — vista principal del dashboard, modo "All
 * projects" (sin filtro de project selector).
 *
 * Layout (KANBAN_DESIGN_BRIEF §4.1):
 *
 *   ┌── Toolbar ──────────────────────────────┐
 *   │ CLAUDE AGENTS                  + ⤴ ⋯    │
 *   │ Project: [ All projects (6)        ▼ ]  │
 *   ├── NOW PLAYING (3) ──────────────────────┤
 *   │ <ProjectGroup A>                        │
 *   │ <ProjectGroup B>                        │
 *   ├── UP NEXT (3) ──────────────────────────┤
 *   │ <ProjectGroup C>                        │
 *   │ <ProjectGroup D>                        │
 *   │ <ProjectGroup E>                        │
 *   ├── RECENT (12) 1 FAILED   ▶  (colapsada) │
 *   └─────────────────────────────────────────┘
 *
 * En esta sub-fase (1.3.c):
 *
 *   - El project selector es ESTÁTICO: muestra "All projects (6) ▼"
 *     pero el chevron no abre nada. Funcionalidad real en 1.3.d.
 *   - Los 3 botones de la toolbar son decorativos.
 *   - NOW PLAYING y UP NEXT arrancan expandidas; RECENT colapsada.
 *   - Click en cualquier section header toggle local de expansión.
 *   - RECENT colapsado significa que NO renderizamos AgentCardRecent
 *     todavía — basta con que el header muestre el counter (12) y
 *     el FailedBadge "1 FAILED" en rojo.
 *
 * La agrupación de NOW/UP por (project + task + branch + batchId) se
 * hace inline acá; el bloque son ~12 líneas y extraer a composable
 * sería abstracción especulativa para un solo call site. Cuando en
 * 1.3.d entre el filtro del project selector, ahí se evalúa.
 */

import { computed, ref } from 'vue';
import { useAgentsStore } from '../stores/useAgentsStore';
import type { Agent } from '../types';
import SectionHeader from '../components/sections/SectionHeader.vue';
import ProjectGroup from '../components/sections/ProjectGroup.vue';
import ProjectGroupHeader from '../components/sections/ProjectGroupHeader.vue';
import AgentCardRunning from '../components/cards/AgentCardRunning.vue';
import AgentCardPending from '../components/cards/AgentCardPending.vue';

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
</script>

<template>
  <div class="dashboard">
    <!-- ============================================================
         === Toolbar superior (KANBAN_DESIGN_BRIEF §5) ===
         Title row + project selector estático. Click handlers son
         placeholders — la funcionalidad entra en 1.3.d.
         ============================================================ -->
    <div class="toolbar">
      <div class="title-row">
        <span class="title">CLAUDE AGENTS</span>
        <div class="toolbar-actions">
          <button type="button" class="toolbar-btn" aria-label="new batch">
            <i class="codicon codicon-add" />
          </button>
          <button type="button" class="toolbar-btn" aria-label="filter">
            <i class="codicon codicon-filter" />
          </button>
          <button type="button" class="toolbar-btn" aria-label="more">
            <i class="codicon codicon-more" />
          </button>
        </div>
      </div>

      <!-- === Project selector (placeholder estático) === -->
      <div class="selector-row">
        <span class="selector-label">Project:</span>
        <button type="button" class="selector-trigger" aria-haspopup="listbox">
          <span class="trigger-text">
            All projects ({{ store.projects.length }})
          </span>
          <i class="codicon codicon-chevron-down chevron" />
        </button>
      </div>
    </div>

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
         Colapsada por default. En esta sub-fase NO renderizamos
         cards (eso es 1.3.d Single project / 1.5 polish). El header
         muestra el counter + el FailedBadge — suficiente para el
         smoke gate.
         ============================================================ -->
    <SectionHeader
      kind="RECENT"
      :count="store.recent.length"
      :failed-count="store.recentFailedCount"
      :expanded="recentOpen"
      @toggle="recentOpen = !recentOpen"
    />
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
   === Toolbar — title row + project selector              ===
   =========================================================== */

.toolbar {
  display: flex;
  flex-direction: column;
}

.title-row {
  height: 35px;
  padding: 0 8px 0 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title {
  font-family: var(--font-ui);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--foreground);
}

.toolbar-actions {
  display: flex;
  gap: 2px;
}

.toolbar-btn {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--foreground);
  opacity: 0.7;
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
}
.toolbar-btn:hover {
  background: rgb(255 255 255 / 0.06);
  opacity: 1;
}
.toolbar-btn .codicon {
  font-size: 14px;
  line-height: 1;
}

/* === Selector row === */
.selector-row {
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.selector-label {
  font-size: 11px;
  color: var(--foreground-muted);
  flex-shrink: 0;
}

.selector-trigger {
  flex: 1;
  height: 26px;
  padding: 0 8px;
  background: var(--background-input);
  border: 1px solid var(--border-input);
  border-radius: 2px;
  color: var(--foreground);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.selector-trigger:hover {
  border-color: var(--foreground-muted);
}
.selector-trigger:focus-visible {
  border-color: var(--focus-ring);
  outline: 1px solid var(--focus-ring);
  outline-offset: 0;
}

.trigger-text {
  flex: 1;
  text-align: left;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.chevron {
  font-size: 10px;
  color: var(--foreground-muted);
  flex-shrink: 0;
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
