<script setup lang="ts">
/**
 * AgentCardPendingStandalone — variante "card propio" del pending
 * agent card, usada en la vista Single project (HANDOFF §2.9.2).
 *
 * Diferencias con AgentCardPending compact:
 *
 *   - Card propio con bg + border + border-radius 6px + border-left
 *     3px pending. Padding 8px 10px.
 *   - Index badge 20×20 (no 18×18).
 *   - El name y el model van apilados en columna (no inline), dando
 *     más jerarquía visual a la fila pending standalone.
 *   - El "X ago" sigue a la derecha.
 *
 * Reusa PriorityPill del atoms set.
 *
 * Referencia: HANDOFF.md §2.9.2.
 */

import { computed } from 'vue';
import type { Agent } from '../../types';
import { formatRelative } from '../../utils/format';
import { useShowDetail } from '../../composables/useShowDetail';
import PriorityPill from '../atoms/PriorityPill.vue';

const props = defineProps<{
  agent: Agent;
  /** Orden 1-based dentro de la sección UP NEXT. */
  index: number;
}>();

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

    <!-- === Content column — name + model apilados === -->
    <div class="content">
      <span class="name">{{ agent.name }}</span>
      <span v-if="agent.model" class="model">{{ agent.model }}</span>
    </div>

    <PriorityPill v-if="agent.priority" :priority="agent.priority" />
    <span class="ago">{{ queuedAgo }}</span>
  </div>
</template>

<style scoped>
.card {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--background-card);
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--stripe-pending);
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  transition: background-color 100ms ease;
}
.card:hover {
  background: var(--card-hover-bg-strong);
}
.card:focus-visible {
  outline: var(--card-focus-outline-width) solid var(--card-focus-outline-color);
  outline-offset: var(--card-focus-outline-offset);
}

/* === Index badge — 20×20 (más grande que el compact 18×18) === */
.index {
  width: 20px;
  height: 20px;
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

/* === Content column — name arriba, model debajo === */
.content {
  flex: 1;
  display: flex;
  flex-direction: column;
  /* Sin gap: el line-height da el spacing visual entre las dos
   * líneas, y eso lee más natural que un gap explícito acá. */
  overflow: hidden;
}

.name {
  font-family: var(--font-ui);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--foreground);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.model {
  font-size: 10.5px;
  color: var(--foreground-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ago {
  font-size: 10.5px;
  color: var(--foreground-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
</style>
