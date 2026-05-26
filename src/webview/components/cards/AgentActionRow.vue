<script setup lang="ts">
/**
 * AgentActionRow — botón Cancel inline para cards running.
 *
 * Decisión deliberada de un solo botón:
 *   - Pause: el SDK Anthropic no lo soporta, solo abort.
 *   - Open in chat: vive en el footer del detail panel (no
 *     duplicarlo en cards). El click en el body de la card abre
 *     el detail panel custom; desde ahí el user puede saltar al
 *     chat oficial si quiere continuar la conversación.
 *
 * Cancel activo solo si el agente está running — el guard refleja
 * la invariante del bridge (bridge.cancel devuelve false en
 * agentes terminales).
 */

import { computed } from 'vue';
import type { Agent } from '../../types';
import { postToExtension } from '../../composables/usePostToExtension';

const props = defineProps<{
  agent: Agent;
}>();

const cancelEnabled = computed(() => props.agent.status === 'running');

function onCancelClick(): void {
  if (!cancelEnabled.value) return;
  postToExtension({ type: 'request_cancel', agentId: props.agent.id });
}
</script>

<template>
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
  opacity: 0.45;
  cursor: not-allowed;
}
.action .codicon {
  font-size: 10px;
  line-height: 1;
}
</style>
