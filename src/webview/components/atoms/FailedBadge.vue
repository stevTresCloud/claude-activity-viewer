<script setup lang="ts">
/**
 * FailedBadge — pill "N FAILED" en rojo.
 *
 * Vive en el section header de RECENT y solo se renderiza cuando
 * hay 1+ agentes failed en las últimas 24h. Cuando `count === 0`
 * el componente no emite nada (un `v-if` en el padre serviría
 * igual; lo dejamos acá para que la decisión viva con el átomo).
 *
 * Diseño: hermano de PriorityPill pero hardcodeado a rojo —
 * `bg: rgb(244 67 54 / 0.15)` + `color: var(--color-error)`.
 *
 * Referencia: HANDOFF.md §2.14.
 */

const props = defineProps<{
  count: number;
}>();
</script>

<template>
  <span v-if="props.count > 0" class="failed-badge">{{ props.count }} FAILED</span>
</template>

<style scoped>
.failed-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  border-radius: 2px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  background: rgb(244 67 54 / 0.15);
  color: var(--color-error);
  line-height: 1.4;
  flex-shrink: 0;
}
</style>
