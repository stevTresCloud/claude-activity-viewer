<script setup lang="ts">
/**
 * Toolbar — header compartido del dashboard.
 *
 * Vive en App.vue (no en cada vista) para que el ProjectSelector
 * mantenga su estado al rotar entre AllProjectsView y
 * SingleProjectView. Si la toolbar viviera en cada vista, el
 * popover del selector se desmontaría/remontaría al cambiar de
 * vista y se sentiría como un parpadeo.
 *
 * Estructura (HANDOFF §5 + §2.15):
 *
 *   ┌─ Title row ──────────────────────────────┐
 *   │ CLAUDE AGENTS                  + ⤴ ⋯    │
 *   ├─ Selector row ───────────────────────────┤
 *   │ Project: [ trigger          ▼ ]          │
 *   ├─ Context line (solo Single project) ─────┤
 *   │ tarea_10794 · feature/SL-10794           │
 *   └──────────────────────────────────────────┘
 *
 * La context line aparece SOLO cuando hay filtro activo. Su
 * contenido (task / branch / fallback) se deriva acá mirando los
 * agentes del proyecto seleccionado.
 *
 * Los 3 botones del title row (+ ⤴ ⋯) son decorativos por ahora;
 * los handlers se cablean cuando exista la UX para "new batch",
 * filtros adicionales y menú de más acciones.
 */

import { computed } from 'vue';
import { useAgentsStore } from '../stores/useAgentsStore';
import { useProjectFilter } from '../composables/useProjectFilter';
import ProjectSelector from './selector/ProjectSelector.vue';
import ProjectContextLine from './sections/ProjectContextLine.vue';

const store = useAgentsStore();
const { selectedProjectId } = useProjectFilter();

// === Resolver projectName del id seleccionado ===

const selectedProjectName = computed<string | null>(() => {
  if (!selectedProjectId.value) return null;
  return (
    store.projects.find((p) => p.id === selectedProjectId.value)?.name ?? null
  );
});

// === Derivación de la context line (task / branch / fallback) ===
//
// Mira TODOS los agentes del proyecto (running + pending + recent).
// Agrupa por la combinación task+branch.
//   - Si todos comparten la misma combinación → muestra "task · branch".
//   - Si hay >1 combinación distinta             → fallback "N tasks ·
//     multiple branches" donde N = cantidad de tasks únicas.
//   - Si el proyecto no tiene agentes (caso teórico al estar
//     filtrado a uno con 0 agentes) → null y la línea se oculta.

interface ContextInfo {
  task: string | null;
  branch: string | null;
  taskCount: number;
}

const contextInfo = computed<ContextInfo | null>(() => {
  if (!selectedProjectName.value) return null;
  const projectAgents = store.agents.filter(
    (a) => a.project === selectedProjectName.value,
  );
  if (projectAgents.length === 0) return null;

  const uniqueTasks = new Set(projectAgents.map((a) => a.task));
  const uniqueBranches = new Set(projectAgents.map((a) => a.branch));

  if (uniqueTasks.size === 1 && uniqueBranches.size === 1) {
    return {
      task: projectAgents[0].task,
      branch: projectAgents[0].branch,
      taskCount: 1,
    };
  }

  return {
    task: null,
    branch: null,
    taskCount: uniqueTasks.size,
  };
});
</script>

<template>
  <div class="toolbar">
    <!-- === Title row + 3 botones decorativos === -->
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

    <!-- === Selector row (label + ProjectSelector) === -->
    <div class="selector-row">
      <span class="selector-label">Project:</span>
      <ProjectSelector />
    </div>

    <!-- === Context line — solo cuando hay filtro activo === -->
    <ProjectContextLine
      v-if="contextInfo"
      :task="contextInfo.task"
      :branch="contextInfo.branch"
      :task-count="contextInfo.taskCount"
    />
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-direction: column;
}

/* === Title row === */
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
</style>
