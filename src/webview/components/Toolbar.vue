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

import { computed, ref, watch } from 'vue';
import { useAgentsStore } from '../stores/useAgentsStore';
import { useScannerStore } from '../stores/useScannerStore';
import { useProjectFilter } from '../composables/useProjectFilter';
import { useNow } from '../composables/useNow';
import { postToExtension } from '../composables/usePostToExtension';
import { formatRelative } from '../utils/format';
import ProjectSelector from './selector/ProjectSelector.vue';
import ProjectContextLine from './sections/ProjectContextLine.vue';

const store = useAgentsStore();
const scanner = useScannerStore();
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

// === Rescan button state ===
//
// El user controla cuándo rescanear (default scannerRefreshSec=0).
// Mostramos "last scan Xs ago" calculado contra useNow() para que
// la etiqueta progrese sola sin trigger manual. `scanning` queda
// true mientras esperamos que el extension host responda; lo
// destrabamos cuando llega un evento `projects_from_disk` o tras
// un timeout defensivo (3s sin respuesta → asumir que algo falló).

const scanning = ref(false);
const now = useNow();

const lastScanLabel = computed<string>(() => {
  // Leemos now.value para que el computed re-evalúe con el tick.
  void now.value;
  if (scanning.value) return 'scanning…';
  if (!scanner.lastScanIso) return 'no scan yet';
  return `last scan ${formatRelative(scanner.lastScanIso)} ago`;
});

function onRescan(): void {
  if (scanning.value) return;
  scanning.value = true;
  postToExtension({ type: 'request_rescan' });
  // Timeout defensivo: si por algún motivo el extension host no
  // responde (process murió, etc.), liberamos el botón a los 5s
  // en vez de dejar el spinner colgado para siempre.
  setTimeout(() => {
    scanning.value = false;
  }, 5_000);
}

function onInjectClaudeMd(): void {
  postToExtension({ type: 'request_inject_claude_md' });
}

// Cuando llega un evento `projects_from_disk` o `sessions_from_disk`,
// el store actualiza `lastScanIso`. Observamos eso para apagar el
// spinner antes del timeout. Usar watch acá evita depender del
// timeout en el happy path.
watch(
  () => scanner.lastScanIso,
  () => {
    scanning.value = false;
  },
);

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
    <!-- === Title row + scan label + 3 botones === -->
    <div class="title-row">
      <span class="title">CLAUDE AGENTS</span>
      <span class="scan-label" :class="{ 'is-scanning': scanning }">
        {{ lastScanLabel }}
      </span>
      <div class="toolbar-actions">
        <!-- Rescan: re-lee projectsRoot + ~/.claude/projects desde
             disco. Default scannerRefreshSec=0 (off), así que es
             el único disparador rutinario. Disabled mientras corre
             un scan para no encolar peticiones. -->
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'is-busy': scanning }"
          aria-label="Rescan projects and sessions"
          :title="`Rescan projects and sessions — ${lastScanLabel}`"
          :disabled="scanning"
          @click="onRescan"
        >
          <i class="codicon codicon-refresh" />
        </button>
        <!-- Inject CLAUDE.md: atajo al re-scan del injector. Útil
             cuando el user abre un workspace nuevo y quiere asegurar
             que la directiva está en su CLAUDE.md sin invocar el
             palette. Modo update-existing-only (no crea archivos
             nuevos — para eso el palette completo). -->
        <button
          type="button"
          class="toolbar-btn"
          aria-label="Inject MCP directive into workspace CLAUDE.md"
          title="Inject MCP directive into workspace CLAUDE.md (updates existing files only)"
          @click="onInjectClaudeMd"
        >
          <i class="codicon codicon-rocket" />
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
  flex-shrink: 0;
}

/* === Scan label === */
/* Estado discreto al lado del título — el user sabe cuándo fue el
 * último refresh sin tener que pasar el mouse sobre el botón. */
.scan-label {
  flex: 1;
  margin-left: 10px;
  font-size: 10px;
  font-weight: 400;
  color: var(--foreground-muted);
  opacity: 0.7;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.scan-label.is-scanning {
  opacity: 1;
  font-style: italic;
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
.toolbar-btn:disabled {
  cursor: progress;
  opacity: 0.4;
}
/* Spinner durante el rescan: rotación lenta del icono refresh. */
.toolbar-btn.is-busy .codicon-refresh {
  animation: rescan-spin 0.9s linear infinite;
}
@keyframes rescan-spin {
  to {
    transform: rotate(360deg);
  }
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
