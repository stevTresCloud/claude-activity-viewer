<script setup lang="ts">
/**
 * ProjectContextLine — línea de contexto que aparece debajo del
 * project selector cuando hay filtro activo (vista Single project).
 *
 * Muestra `{session-8} · {branch}` en mono muted. Cuando el proyecto
 * tiene múltiples sesiones o branches, cae a un fallback con count
 * de sesiones + indicador "multiple branches".
 *
 * Vive dentro del Toolbar (no de las vistas) porque conceptualmente
 * pertenece al estado del selector, no al body del dashboard.
 *
 * Referencia: HANDOFF.md §2.15.
 */

import { computed } from 'vue';
import { formatShortSession } from '../../utils/format';

const props = defineProps<{
  /** sessionId activo único, o null si hay múltiples / ninguno. */
  session: string | null;
  /** Branch del cwd. Null cuando session también es null. */
  branch: string | null;
  /** Cantidad de sesiones activas (usado para el fallback). */
  sessionCount: number;
}>();

const shortSession = computed(() =>
  props.session ? formatShortSession(props.session) : null,
);

const fallbackLabel = computed(() => {
  if (props.sessionCount <= 0) return 'No active sessions';
  const word = props.sessionCount === 1 ? 'session' : 'sessions';
  return `${props.sessionCount} ${word} · multiple branches`;
});
</script>

<template>
  <div class="context-line">
    <template v-if="shortSession && branch">{{ shortSession }} · {{ branch }}</template>
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
