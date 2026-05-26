<script setup lang="ts">
/**
 * ProjectSelector — combobox del header del dashboard.
 *
 * Dos piezas visuales:
 *
 *   1. Trigger (HANDOFF §2.2): button con border + chevron animado.
 *      Cuando "All projects" → `All projects (N)` con chevron solo.
 *      Cuando hay filtro     → `● {project} (M)` con dot lifecycle.
 *
 *   2. Popover (HANDOFF §2.3): dropdown absoluto debajo del trigger,
 *      alineado con el ancho del trigger (NO con el label "Project:"
 *      de la izquierda — eso es deliberado del brief). Contiene 3
 *      bloques separados por divider: All projects | active | idle
 *      | inactive.
 *
 * Interacciones:
 *
 *   - Click trigger → toggle open.
 *   - Click row → selectProject(id) + close.
 *   - Click All projects → clearFilter + close.
 *   - Click fuera del popover y trigger → close (sin cambiar selección).
 *   - Esc con popover abierto → close.
 *
 * Los listeners de click-outside y Esc se montan/desmontan dinámicamente
 * con `watchEffect(() => { if (open) attach else detach })` para no
 * pagar el costo cuando el popover está cerrado.
 *
 * a11y: `role="combobox"` + `aria-haspopup="listbox"` +
 * `aria-expanded` en el trigger; `role="listbox"` en el popover;
 * `role="option"` en cada fila (la pone ProjectSelectorRow).
 *
 * Referencia: HANDOFF.md §2.2 + §2.3 + §2.4.
 */

import { computed, onBeforeUnmount, ref, watchEffect } from 'vue';
import { useAgentsStore, MOCK_NOW_ISO } from '../../stores/useAgentsStore';
import { useProjectFilter } from '../../composables/useProjectFilter';
import { formatRelative } from '../../utils/format';
import type { Project } from '../../types';
import ProjectSelectorRow from './ProjectSelectorRow.vue';
import StatusDot from '../atoms/StatusDot.vue';

const store = useAgentsStore();
const { selectedProjectId, selectProject, clearFilter } = useProjectFilter();

// === Estado local del popover ===

const open = ref(false);
const triggerRef = ref<HTMLButtonElement | null>(null);
const popoverRef = ref<HTMLDivElement | null>(null);

function togglePopover(): void {
  open.value = !open.value;
}

function closePopover(): void {
  open.value = false;
}

// === Agentes por proyecto (para los counts de cada row) ===
//
// El brief muestra `(N)` al lado de cada proyecto = total de agentes
// del proyecto sumando running + pending + recent. Lo derivamos
// inline acá porque solo el selector lo necesita; si más componentes
// lo consumieran lo subiríamos a un getter del store.

const agentsByProject = computed(() => {
  const counts = new Map<string, number>();
  for (const a of store.agents) {
    counts.set(a.project, (counts.get(a.project) ?? 0) + 1);
  }
  return counts;
});

function countFor(projectName: string): number {
  return agentsByProject.value.get(projectName) ?? 0;
}

// === Proyecto actualmente seleccionado (para pintar el trigger) ===

const selectedProject = computed<Project | null>(() => {
  if (!selectedProjectId.value) return null;
  return store.projects.find((p) => p.id === selectedProjectId.value) ?? null;
});

// === Sub line de cada row (active / idle Xh ago / inactive Xd ago) ===

function subLineFor(project: Project): string {
  switch (project.lifecycle) {
    case 'active':
      return `${project.activeTask ?? '—'} · active`;
    case 'idle': {
      const ago = formatRelative(project.lastUpdateIso, MOCK_NOW_ISO);
      return `${project.activeTask ?? '—'} · idle ${ago} ago`;
    }
    case 'inactive': {
      const ago = formatRelative(project.lastUpdateIso, MOCK_NOW_ISO);
      return `${project.activeTask ?? '—'} · inactive ${ago} ago`;
    }
  }
}

// === Handlers de selección ===

function onSelectAll(): void {
  clearFilter();
  closePopover();
}

function onSelectProject(id: string): void {
  selectProject(id);
  closePopover();
}

// === Click-outside + Esc ===
//
// composedPath() en lugar de `contains()` para que la detección
// funcione si en el futuro el popover se mueve a un <Teleport>.

function onDocumentMousedown(event: MouseEvent): void {
  const path = event.composedPath();
  const trigger = triggerRef.value;
  const popover = popoverRef.value;
  if (trigger && path.includes(trigger)) return;
  if (popover && path.includes(popover)) return;
  closePopover();
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    closePopover();
    triggerRef.value?.focus();
  }
}

watchEffect((onCleanup) => {
  if (!open.value) return;
  document.addEventListener('mousedown', onDocumentMousedown);
  document.addEventListener('keydown', onDocumentKeydown);
  onCleanup(() => {
    document.removeEventListener('mousedown', onDocumentMousedown);
    document.removeEventListener('keydown', onDocumentKeydown);
  });
});

// Defensive: si el componente se desmonta con popover abierto,
// watchEffect ya limpia, pero dejamos guard por si Vue cambia
// el orden de cleanup en versiones futuras.
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMousedown);
  document.removeEventListener('keydown', onDocumentKeydown);
});

// === Trigger label ===
//
// El dot del trigger se renderiza directamente con <StatusDot
// :status="selectedProject.lifecycle" /> en el template — eso reusa
// la lógica de color del átomo en vez de mapearla acá.

const triggerLabel = computed(() => {
  if (selectedProject.value) {
    return `${selectedProject.value.name} (${countFor(selectedProject.value.name)})`;
  }
  return `All projects (${store.projects.length})`;
});
</script>

<template>
  <div class="selector-wrapper">
    <!-- ============================================================
         === Trigger ===
         ============================================================ -->
    <button
      ref="triggerRef"
      type="button"
      class="trigger"
      :class="{ 'is-open': open }"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="togglePopover"
    >
      <StatusDot
        v-if="selectedProject"
        :status="selectedProject.lifecycle"
      />
      <span class="trigger-text">{{ triggerLabel }}</span>
      <i
        class="codicon codicon-chevron-down chevron"
        :class="{ 'chevron-up': open }"
      />
    </button>

    <!-- ============================================================
         === Popover ===
         Sólo se monta cuando open=true (evita overhead + saca el
         listener del DOM cuando no está visible).
         ============================================================ -->
    <div
      v-if="open"
      ref="popoverRef"
      class="popover dropdown-popover"
      role="listbox"
    >
      <!-- All projects -->
      <ProjectSelectorRow
        variant="all"
        label="All projects"
        :count="store.projects.length"
        :selected="selectedProjectId === null"
        @select="onSelectAll"
      />

      <!-- Divider entre All projects y active -->
      <div
        v-if="store.projectsByLifecycle.active.length > 0"
        class="divider"
      />

      <!-- Active -->
      <ProjectSelectorRow
        v-for="p in store.projectsByLifecycle.active"
        :key="p.id"
        variant="active"
        :label="p.name"
        :count="countFor(p.name)"
        :sub="subLineFor(p)"
        :selected="selectedProjectId === p.id"
        @select="onSelectProject(p.id)"
      />

      <!-- Divider entre active e idle -->
      <div
        v-if="
          store.projectsByLifecycle.active.length > 0 &&
          store.projectsByLifecycle.idle.length > 0
        "
        class="divider"
      />

      <!-- Idle -->
      <ProjectSelectorRow
        v-for="p in store.projectsByLifecycle.idle"
        :key="p.id"
        variant="idle"
        :label="p.name"
        :count="countFor(p.name)"
        :sub="subLineFor(p)"
        :selected="selectedProjectId === p.id"
        @select="onSelectProject(p.id)"
      />

      <!-- Divider entre idle e inactive -->
      <div
        v-if="
          store.projectsByLifecycle.idle.length > 0 &&
          store.projectsByLifecycle.inactive.length > 0
        "
        class="divider"
      />

      <!-- Inactive -->
      <ProjectSelectorRow
        v-for="p in store.projectsByLifecycle.inactive"
        :key="p.id"
        variant="inactive"
        :label="p.name"
        :count="countFor(p.name)"
        :sub="subLineFor(p)"
        :selected="selectedProjectId === p.id"
        @select="onSelectProject(p.id)"
      />
    </div>
  </div>
</template>

<style scoped>
.selector-wrapper {
  flex: 1;
  position: relative;
}

/* ============================================================
   === Trigger ===
   ============================================================ */
.trigger {
  width: 100%;
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
  font-family: var(--font-ui);
}
.trigger:hover {
  border-color: var(--foreground-muted);
}
.trigger.is-open,
.trigger:focus-visible {
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
  transition: transform 150ms ease;
}
.chevron-up {
  transform: rotate(180deg);
}

/* ============================================================
   === Popover ===
   ============================================================ */
.popover {
  position: absolute;
  top: 32px; /* trigger 26px + 6px gap */
  left: 0;
  right: 0;
  z-index: 20;
  background: var(--background-dropdown);
  border: 1px solid var(--border-dropdown);
  border-radius: 4px;
  box-shadow: 0 4px 14px rgb(0 0 0 / 0.5);
  padding: 4px;
  max-height: 340px;
  overflow-y: auto;
  animation: dropdown-in 150ms ease-out;
}

.divider {
  height: 1px;
  background: var(--border-input);
  margin: 4px 6px;
}
</style>
