<script setup lang="ts">
/**
 * AgentActionRow — fila de 3 botones de acción compartida entre
 * AgentCardRunning (in-group) y AgentCardRunningStandalone.
 *
 * Botones:
 *   - Pause: disabled hard (el SDK Anthropic no soporta pause —
 *     limitación estructural, no "available v0.X").
 *   - Cancel: activo siempre que el agente esté running. Despacha
 *     `request_cancel` al extension host; el bridge ya tiene el
 *     AbortController por agente. Confirmación opcional vive del
 *     lado extension (setting `cancelConfirm`).
 *   - Open: activo solo cuando el agente ya tiene `sessionId`
 *     (el SDK tarda 1-2 frames en proveerlo). Despacha
 *     `request_open` y el scanner-controller invoca el URI handler
 *     del plugin claude-code con `?session=<id>` para abrir el
 *     chat con la sesión cargada.
 *
 * Layout: row flex con gap de 6px. El parent agrega `flex: 1`
 * `progress-track` si quiere mostrar el sweep al lado.
 */

import { computed } from 'vue';
import type { Agent } from '../../types';
import { postToExtension } from '../../composables/usePostToExtension';

const props = defineProps<{
  agent: Agent;
}>();

// Open requiere ambas condiciones:
//   1. status='running' — un agente done/failed/cancelled todavía
//      tiene sessionId válido (la sesión existe en .jsonl), pero
//      "Open in chat" sobre un agente muerto es confuso y la UI
//      debería redirigir a "Resume past session" del SessionCard
//      cuando aparezca en RECENT.
//   2. sessionId presente — el SDK tarda 1-2 frames en proveerlo.
//
// Cancel: análogo, sólo válido en running. AgentActionRow vive en
// cards running, pero el guard refleja la invariante del bridge
// (bridge.cancel devuelve false en agentes terminales).
const openEnabled = computed(
  () => props.agent.status === 'running' && !!props.agent.sessionId,
);
const cancelEnabled = computed(() => props.agent.status === 'running');

function onCancelClick(): void {
  if (!cancelEnabled.value) return;
  postToExtension({ type: 'request_cancel', agentId: props.agent.id });
}

function onOpenClick(): void {
  if (!openEnabled.value) return;
  postToExtension({ type: 'request_open', agentId: props.agent.id });
}
</script>

<template>
  <button
    type="button"
    class="action"
    disabled
    aria-disabled="true"
    title="Pause is not supported by the Claude SDK"
  >
    <i class="codicon codicon-debug-pause" />
  </button>
  <button
    type="button"
    class="action"
    :disabled="!cancelEnabled"
    :aria-disabled="!cancelEnabled"
    :aria-label="`Cancel agent ${agent.name}`"
    :title="cancelEnabled ? `Cancel agent ${agent.name}` : 'Agent is no longer running'"
    @click.stop="onCancelClick"
  >
    <i class="codicon codicon-close" />
  </button>
  <button
    type="button"
    class="action"
    :disabled="!openEnabled"
    :aria-disabled="!openEnabled"
    :aria-label="`Open ${agent.name} in Claude chat`"
    :title="openEnabled ? `Open ${agent.name} in Claude chat` : 'Session not started yet'"
    @click.stop="onOpenClick"
  >
    <i class="codicon codicon-link-external" />
  </button>
</template>

<style scoped>
.action {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-subtle);
  background: var(--background-button-secondary);
  color: var(--foreground);
  border-radius: 3px;
  cursor: pointer;
  padding: 0;
}
.action:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.1);
}
.action:disabled {
  /* Disabled visual: el botón sigue visible para no romper el
   * balance del row, pero pierde foco y cursor de acción. */
  opacity: 0.45;
  cursor: not-allowed;
}
.action .codicon {
  font-size: 10px;
  line-height: 1;
}
</style>
