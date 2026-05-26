<script setup lang="ts">
/**
 * ProjectSelectorRow — una fila del popover del ProjectSelector.
 *
 * El popover muestra 3 bloques visuales (All projects | active |
 * idle+inactive) separados por divider. Cada fila es este
 * componente con un `variant` distinto que define icon + sub line +
 * opacity:
 *
 *   - all      → dot filled muted (neutral), sin sub line
 *   - active   → dot filled verde
 *   - idle     → ring outlined muted
 *   - inactive → ring outlined muted + opacity 0.55 en toda la fila
 *
 * Mantener `variant` como prop discreto (en vez de inferirlo del
 * status del proyecto) facilita el caso especial "All projects"
 * que no tiene lifecycle propio — lo mapeamos al kind sintético
 * 'neutral' de StatusDot.
 *
 * Referencia: HANDOFF.md §2.4.
 */

import { computed } from 'vue';
import StatusDot from '../atoms/StatusDot.vue';

export type RowVariant = 'all' | 'active' | 'idle' | 'inactive';

const props = withDefaults(
  defineProps<{
    variant: RowVariant;
    label: string;
    count: number;
    /**
     * Sesiones históricas en disco del proyecto. Cuando > 0, el
     * counter se renderea como "(N · Ms)" donde N=agents y M=sessions;
     * cuando es 0 (o el caso "all"), cae al formato simple "(N)".
     */
    sessionsCount?: number;
    /** Línea 2 opcional ("tarea_NNNN · active", etc.). */
    sub?: string;
    /** Resaltado cuando es el filtro actualmente activo. */
    selected?: boolean;
  }>(),
  { sub: '', selected: false, sessionsCount: 0 },
);

defineEmits<{
  (event: 'select'): void;
}>();

// === Mapeo variant → DotKind del StatusDot ===
//
// 'all' usa el kind sintético 'neutral' (filled muted). Los otros 3
// son lifecycles del proyecto y mapean 1:1.

const dotKind = computed(() => {
  if (props.variant === 'all') return 'neutral' as const;
  return props.variant;
});

const isDimmed = computed(() => props.variant === 'inactive');

/**
 * Counter visible. Sin sesiones → formato simple "(N)". Con
 * sesiones → "(N · Ms)" donde N=agents y M=sessions. La notación
 * compacta evita inflar el ancho del row.
 */
const counterLabel = computed(() => {
  if (props.sessionsCount > 0) {
    return `(${props.count} · ${props.sessionsCount}s)`;
  }
  return `(${props.count})`;
});
</script>

<template>
  <div
    class="row"
    role="option"
    :aria-selected="selected"
    :class="{ 'is-dimmed': isDimmed, 'is-selected': selected }"
    @click="$emit('select')"
  >
    <!-- === Row 1: icon + label + count === -->
    <div class="row-1">
      <StatusDot :status="dotKind" />
      <span class="label">{{ label }}</span>
      <span class="count">{{ counterLabel }}</span>
    </div>

    <!-- === Row 2: sub line opcional === -->
    <div v-if="sub" class="row-2">{{ sub }}</div>
  </div>
</template>

<style scoped>
.row {
  padding: 6px 8px;
  border-radius: 3px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.row:hover {
  background: rgb(255 255 255 / 0.06);
}
/* Selected gana sobre hover — el bg de selección es opaco y más
 * intenso, así que el hover encima no se nota. */
.row.is-selected {
  background: var(--background-selection-active);
}
.row.is-dimmed {
  opacity: 0.55;
}

/* === Row 1 === */
.row-1 {
  display: flex;
  align-items: center;
  gap: 7px;
}

.label {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
  color: var(--foreground);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.count {
  font-size: 11px;
  color: var(--foreground-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

/* === Row 2 — sub line mono === */
.row-2 {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--foreground-muted);
  /* Indent bajo el label: dot 7px + gap 7px = 14px. */
  padding-left: 14px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
