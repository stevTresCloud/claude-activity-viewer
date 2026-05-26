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
import { formatElapsed, formatTokens } from '../../utils/format';
import { postToExtension } from '../../composables/usePostToExtension';

const props = defineProps<{
  agent: Agent;
}>();

// Open: abre la sesión histórica en el chat del plugin claude-code
// (mismo URI handler que el Resume de SessionCard). Solo aparece
// cuando el agente alcanzó a registrar sessionId — agentes que
// murieron pre-init no tienen sesión que abrir.
function onOpenClick(): void {
  if (!props.agent.sessionId) return;
  postToExtension({ type: 'request_open', agentId: props.agent.id });
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

// === Meta — duración + tokens si done ===
//
// HANDOFF §2.10 dicta misma grilla "Xm Ys" para done/failed/cancelled.
// done agrega "· {tokens}k" porque tiene tokensUsed; failed/cancelled
// dejan solo la duración.

const meta = computed(() => {
  const duration = formatElapsed(props.agent.durationMs);
  if (props.agent.status === 'done') {
    return `${duration} · ${formatTokens(props.agent.tokensUsed)}`;
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
  >
    <i
      class="codicon icon"
      :class="presentation.iconClass"
      :style="{ color: presentation.color }"
    />
    <span class="name">{{ agent.name }}</span>
    <span class="meta">{{ meta }}</span>
    <button
      v-if="agent.sessionId"
      type="button"
      class="open-btn"
      :aria-label="`Open ${agent.name} in Claude chat`"
      :title="`Open ${agent.name} in Claude chat`"
      @click.stop="onOpenClick"
    >
      <i class="codicon codicon-link-external" />
    </button>
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

/* === Botón Open compact al final del row ===
 * Solo visible cuando agent.sessionId está presente. Tamaño más
 * chico que las .action buttons de cards running (los rows recent
 * son de 1 sola línea más compactos). */
.open-btn {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--foreground-muted);
  border-radius: 3px;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  opacity: 0.6;
  transition: opacity 120ms ease, background-color 120ms ease;
}
.open-btn:hover {
  opacity: 1;
  background: rgb(255 255 255 / 0.08);
  color: var(--foreground);
}
.open-btn .codicon {
  font-size: 11px;
  line-height: 1;
}
</style>
