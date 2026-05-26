<script setup lang="ts">
/**
 * AgentCardPending — variante compacta para UP NEXT dentro de un
 * project group (HANDOFF §2.9.1).
 *
 * Una sola línea: stripe 3px amarillo + index badge + name +
 * PriorityPill + "X ago" (vía formatRelative).
 *
 * `index` viene del padre con el orden dentro del proyecto (1-based
 * porque el brief lo muestra "1", "2"... no "0").
 *
 * Referencia: HANDOFF.md §2.9.1.
 */

import { computed } from 'vue';
import type { Agent } from '../../types';
import { formatRelative } from '../../utils/format';
import { useShowDetail } from '../../composables/useShowDetail';
import PriorityPill from '../atoms/PriorityPill.vue';

const props = defineProps<{
  agent: Agent;
  /** Orden 1-based dentro del project group. */
  index: number;
}>();

// === "X ago" derivado del queued_since vs el now actual ===

const queuedAgo = computed(() => formatRelative(props.agent.queuedSinceIso));

const detail = useShowDetail();
function onBodyClick(): void {
  detail.show(props.agent.id);
}
</script>

<template>
  <div
    class="card"
    role="button"
    :aria-label="`Open ${agent.name} detail view`"
    tabindex="0"
    @click="onBodyClick"
    @keydown.enter="onBodyClick"
    @keydown.space.prevent="onBodyClick"
  >
    <span class="index">{{ index }}</span>
    <span class="name">{{ agent.name }}</span>
    <PriorityPill v-if="agent.priority" :priority="agent.priority" />
    <span class="ago">{{ queuedAgo }}</span>
  </div>
</template>

<style scoped>
.card {
  display: flex;
  align-items: center;
  gap: 8px;
  /* Stripe 3px amarilla (pending). */
  border-left: 3px solid var(--stripe-pending);
  padding-left: 9px;
  margin-left: -2px;
  cursor: pointer;
  border-radius: 3px;
  transition: background-color 100ms ease;
}
.card:hover {
  background: var(--card-hover-bg-subtle);
}
.card:focus-visible {
  outline: var(--card-focus-outline-width) solid var(--card-focus-outline-color);
  outline-offset: var(--card-focus-outline-offset);
}

/* === Index badge — 18×18 cuadrado con borde, look "queue position" === */
.index {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--background-index-badge);
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  font-size: 10px;
  color: var(--foreground-muted);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.name {
  flex: 1;
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 500;
  color: var(--foreground);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ago {
  font-size: 10px;
  color: var(--foreground-muted);
  font-variant-numeric: tabular-nums;
  min-width: 22px;
  text-align: right;
  flex-shrink: 0;
}
</style>
