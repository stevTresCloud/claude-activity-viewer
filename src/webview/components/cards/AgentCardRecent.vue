<script setup lang="ts">
/**
 * AgentCardRecent — variante mínima (1 línea) para RECENT.
 *
 * Layout (HANDOFF §2.10):
 *   [stripe 2px] [icon] {name}                    {meta}
 *
 * Meta depende del status:
 *   - done:      "Xm Ys · 12.5k"
 *   - cancelled: "cancelled"
 *   - failed:    "Xm Ys"
 *
 * El stripe es 2px (no 3px como running/pending) — el HANDOFF usa
 * el ancho como señal sutil de "esto ya está cerrado, menos énfasis
 * visual". Failed además lleva un tinte de fondo rojo muy suave
 * para que destaque sin gritar.
 *
 * Este componente se crea en 1.3.c para no fragmentar el trabajo —
 * en la vista All projects la sección RECENT va colapsada por
 * default, así que no se renderiza. Queda list-ready para 1.3.d
 * (Single project view) y para 1.5 cuando RECENT se vuelva
 * expandible interactivamente.
 *
 * Referencia: HANDOFF.md §2.10.
 */

import { computed } from 'vue';
import type { Agent } from '../../types';
import { formatDuration, formatTokens } from '../../utils/format';

const props = defineProps<{
  agent: Agent;
}>();

// === Stripe color + icon por status ===

const stripeColor = computed(() => {
  switch (props.agent.status) {
    case 'done':
      return 'var(--color-success)';
    case 'failed':
      return 'var(--color-error)';
    case 'cancelled':
    default:
      return 'var(--color-muted)';
  }
});

const iconClass = computed(() => {
  switch (props.agent.status) {
    case 'done':
      return 'codicon-check';
    case 'failed':
      return 'codicon-warning';
    case 'cancelled':
    default:
      return 'codicon-circle-slash';
  }
});

const iconColor = computed(() => {
  switch (props.agent.status) {
    case 'done':
      return 'var(--color-success)';
    case 'failed':
      return 'var(--color-error)';
    case 'cancelled':
    default:
      return 'var(--color-muted)';
  }
});

// === Meta derivado del status ===

const meta = computed(() => {
  const duration = formatDuration(props.agent.durationMs);
  switch (props.agent.status) {
    case 'done':
      return `${duration} · ${formatTokens(props.agent.tokensUsed)}`;
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    default:
      return duration;
  }
});

// === Failed bg tint condicional ===

const isFailed = computed(() => props.agent.status === 'failed');
</script>

<template>
  <div
    class="card"
    :class="{ 'is-failed': isFailed }"
    :style="{ borderLeftColor: stripeColor }"
  >
    <i class="codicon icon" :class="iconClass" :style="{ color: iconColor }" />
    <span class="name">{{ agent.name }}</span>
    <span class="meta">{{ meta }}</span>
  </div>
</template>

<style scoped>
.card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 3px;
  /* Stripe 2px (no 3px). El color se setea inline via style binding. */
  border-left: 2px solid var(--color-muted);
  /* HANDOFF §2.10: rows recent un poco apagados, excepto failed. */
  opacity: 0.78;
}
.card.is-failed {
  opacity: 1;
  background: rgb(244 67 54 / 0.06);
}

.icon {
  width: 12px;
  font-size: 12px;
  text-align: center;
  flex-shrink: 0;
}

.name {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
  color: var(--foreground);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.meta {
  font-size: 10px;
  color: var(--foreground-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
</style>
