<script setup lang="ts">
/**
 * ProjectContextLine — línea de contexto que aparece debajo del
 * project selector cuando hay filtro activo (vista Single project).
 *
 * Muestra `{task} · {branch}` en mono muted. Cuando el proyecto
 * tiene múltiples tasks o branches, cae a un fallback con count
 * de tasks + indicador "multiple branches" — el detalle del
 * task/branch específico se pierde porque no caben los N a la vez.
 *
 * Vive dentro del Toolbar (no de las vistas) porque conceptualmente
 * pertenece al estado del selector, no al body del dashboard.
 *
 * Referencia: HANDOFF.md §2.15.
 */

import { computed } from 'vue';

const props = defineProps<{
  /** Task activa única, o null si hay múltiples / ninguna. */
  task: string | null;
  /** Branch del cwd. Null cuando task también es null. */
  branch: string | null;
  /** Cantidad de tasks activas (usado para el fallback). */
  taskCount: number;
}>();

// Fallback con singular/plural correcto. El caller (Toolbar) pone
// task=null cuando hay >1 task O >1 branch para la misma task.
// El caso `taskCount=1` (1 task, varias branches) requiere singular.
const fallbackLabel = computed(() => {
  if (props.taskCount <= 0) return 'No active tasks';
  const word = props.taskCount === 1 ? 'task' : 'tasks';
  return `${props.taskCount} ${word} · multiple branches`;
});
</script>

<template>
  <div class="context-line">
    <template v-if="task && branch">{{ task }} · {{ branch }}</template>
    <template v-else>{{ fallbackLabel }}</template>
  </div>
</template>

<style scoped>
.context-line {
  padding: 6px 12px 8px;
  border-bottom: 1px solid var(--border-subtle);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--foreground-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
