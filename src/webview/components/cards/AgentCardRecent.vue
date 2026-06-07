<script setup lang="ts">
/**
 * AgentCardRecent — variante mínima (1 línea) para RECENT.
 *
 * Layout (HANDOFF §2.10):
 *   [stripe 2px] [icon] {name}                    {meta}
 *
 * Meta depende del status:
 *   - done:      "Xm Ys · 12.5k"
 *   - failed:    "Xm Ys"
 *   - cancelled: "Xm Ys"
 *
 * El stripe es 2px (no 3px como running/pending) — el HANDOFF usa
 * el ancho como señal sutil de "esto ya está cerrado, menos énfasis
 * visual". Failed además lleva un tinte de fondo rojo muy suave
 * para que destaque sin gritar.
 *
 * Referencia: HANDOFF.md §2.10.
 */

import { computed } from 'vue';
import type { Agent, AgentStatus } from '../../types';
import { formatCostUsd, formatElapsed, formatTokens } from '../../utils/format';
import { useShowDetail } from '../../composables/useShowDetail';

const props = defineProps<{
  agent: Agent;
}>();

// Click en el body de la card abre el detail panel custom (editor
// tab). Desde el footer del detail el user puede saltar al chat
// oficial via "Open in Claude chat" si quiere continuar la
// conversación post-mortem.
const detail = useShowDetail();
function onBodyClick(): void {
  detail.show(props.agent.id);
}

// === Map de presentación por status (color del stripe/icon + glyph) ===
//
// Un solo lookup vs 3 switch separados. Si cambia el mapeo (ej.
// `cancelled` empieza a usar otro icon), tocamos un solo lugar.

const STATUS_PRESENTATION = {
  done: { color: 'var(--stripe-done)', iconClass: 'codicon-check' },
  failed: { color: 'var(--stripe-failed)', iconClass: 'codicon-warning' },
  cancelled: {
    color: 'var(--stripe-cancelled)',
    iconClass: 'codicon-circle-slash',
  },
} as const satisfies Record<
  'done' | 'failed' | 'cancelled',
  { color: string; iconClass: string }
>;

/**
 * Helper para resolver presentación con guard del status. Si llega
 * un status raro (no debería en RECENT), cae a `cancelled`.
 */
function presentationFor(status: AgentStatus) {
  if (status === 'done' || status === 'failed' || status === 'cancelled') {
    return STATUS_PRESENTATION[status];
  }
  return STATUS_PRESENTATION.cancelled;
}

const presentation = computed(() => presentationFor(props.agent.status));

// === Meta — duración + tokens + costo si done ===
//
// HANDOFF §2.10 dicta misma grilla "Xm Ys" para done/failed/cancelled.
// done agrega "· {tokens}k · ${cost}" porque tiene cost/tokens útiles;
// failed/cancelled dejan solo la duración para no contaminar visual con
// métricas parciales que no representan trabajo completo.

const meta = computed(() => {
  const duration = formatElapsed(props.agent.durationMs);
  if (props.agent.status === 'done') {
    const tokens = formatTokens(props.agent.tokensUsed);
    const cost = formatCostUsd(props.agent.costUsd);
    return `${duration} · ${tokens} · ${cost}`;
  }
  return duration;
});

const isFailed = computed(() => props.agent.status === 'failed');
</script>

<template>
  <div
    class="card"
    :class="{ 'is-failed': isFailed }"
    :style="{ borderLeftColor: presentation.color }"
    role="button"
    :aria-label="`Open ${agent.name} detail view`"
    tabindex="0"
    @click="onBodyClick"
    @keydown.enter="onBodyClick"
    @keydown.space.prevent="onBodyClick"
  >
    <i
      class="codicon icon"
      :class="presentation.iconClass"
      :style="{ color: presentation.color }"
    />
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
  cursor: pointer;
  transition: background-color 100ms ease, opacity 100ms ease;
}
.card:hover {
  opacity: 1;
  background: var(--card-hover-bg-strong);
}
.card:focus-visible {
  outline: var(--card-focus-outline-width) solid var(--card-focus-outline-color);
  outline-offset: var(--card-focus-outline-offset);
  opacity: 1;
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
