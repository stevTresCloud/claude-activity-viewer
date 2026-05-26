<script setup lang="ts">
/**
 * AgentCardRunning — variante "dentro de project group" (HANDOFF
 * §2.8.1). Sin background propio: la card padre (ProjectGroup) trae
 * el bg y border; aquí solo aportamos:
 *
 *   - stripe 3px azul (running) a la izquierda
 *   - 4 líneas verticales:
 *       L1: dot pulse + name + ModelBadge + elapsed
 *       L2: subtitle · current_tool
 *       L3: ContextBar
 *       L4: 3 botones decorativos + sweeping progress bar
 *
 * El `margin-left: -2px` alinea el stripe con el borde izquierdo del
 * container del project group (que tiene padding 10px). Sin el
 * margin, la stripe queda 2px adentro y se nota un escalón.
 *
 * Los botones son decorativos por ahora; los handlers se cablean
 * cuando la extensión y el webview hablen via postMessage.
 *
 * La variante "standalone" (vista Single project) existe como
 * componente separado en `AgentCardRunningStandalone.vue` para no
 * inflar este con un prop boolean que cambia 4 estilos.
 *
 * Referencia: HANDOFF.md §2.8.1.
 */

import { computed } from 'vue';
import type { Agent } from '../../types';
import { formatElapsed } from '../../utils/format';
import { useNow } from '../../composables/useNow';
import StatusDot from '../atoms/StatusDot.vue';
import ContextBar from '../atoms/ContextBar.vue';
import ModelBadge from '../atoms/ModelBadge.vue';

const props = defineProps<{
  agent: Agent;
}>();

// === Format derivado ===
//
// El elapsed lo derivamos en runtime contra el tick global de
// useNow() — el wire trae startedAtIso (timestamp absoluto) pero
// NO emite agent_status_changed cada segundo para el contador.
// Si el agente no tiene startedAtIso (edge case del wire),
// caemos al elapsedMs que mandó el bridge.
const now = useNow();
const elapsedText = computed(() => {
  if (props.agent.startedAtIso) {
    const started = Date.parse(props.agent.startedAtIso);
    if (Number.isFinite(started)) {
      return formatElapsed(now.value - started);
    }
  }
  return formatElapsed(props.agent.elapsedMs);
});
</script>

<template>
  <div class="card">
    <!-- === L1: dot + name + model + elapsed === -->
    <div class="line line-1">
      <StatusDot status="running" pulse />
      <span class="name">{{ agent.name }}</span>
      <ModelBadge v-if="agent.model" :model="agent.model" />
      <span class="elapsed">{{ elapsedText }}</span>
    </div>

    <!-- === L2: subtitle · current_tool === -->
    <div v-if="agent.subtitle || agent.currentTool" class="line indented sub">
      <span v-if="agent.subtitle">{{ agent.subtitle }}</span>
      <template v-if="agent.subtitle && agent.currentTool"> · </template>
      <span v-if="agent.currentTool" class="tool">{{ agent.currentTool }}</span>
    </div>

    <!-- === L3: context bar === -->
    <div v-if="agent.contextUsedPct !== undefined" class="line indented">
      <ContextBar :pct="agent.contextUsedPct" :tokens-used="agent.tokensUsed" />
    </div>

    <!-- === L4: actions inline + sweeping progress bar === -->
    <div class="line indented actions">
      <button type="button" class="action" aria-label="pause">
        <i class="codicon codicon-debug-pause" />
      </button>
      <button type="button" class="action" aria-label="cancel">
        <i class="codicon codicon-close" />
      </button>
      <button type="button" class="action" aria-label="open">
        <i class="codicon codicon-link-external" />
      </button>
      <div class="progress-track">
        <div class="progress-bar sweep-bar" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* === Container — stripe izquierda + verticals === */
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* Stripe 3px de status — color hardcoded a running porque este
   * componente solo se usa para running. */
  border-left: 3px solid var(--stripe-running);
  padding-left: 9px;
  /* Alinea el stripe con el borde interno del container del project
   * group, que tiene padding-left 10px. */
  margin-left: -2px;
}

.line {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* === L1 — name + model + elapsed === */
.line-1 .name {
  flex: 1;
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 500;
  color: var(--foreground);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.elapsed {
  font-size: 11px;
  color: var(--foreground-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

/* === L2/L3/L4 — indent ignorando el dot del L1 ===
 * Dot 7px + gap 6px = 13px, como dice HANDOFF §2.8.1. */
.indented {
  padding-left: 13px;
}

/* === L2 — subtitle muted, tool con foreground destacado === */
.sub {
  font-size: 11px;
  color: var(--foreground-muted);
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.sub .tool {
  color: var(--foreground);
}

/* === L4 — actions + sweeping bar === */
.actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
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
.action:hover {
  background: rgb(255 255 255 / 0.1);
}
.action .codicon {
  font-size: 10px;
  line-height: 1;
}

/* Sweeping bar: vive en su propio track de 2px que toma el espacio
 * sobrante del row de actions. El bar interno tiene width 25% y se
 * desplaza con keyframes `sweep` (declarado en style.css). */
.progress-track {
  flex: 1;
  margin-left: 6px;
  height: 2px;
  border-radius: 1px;
  background: var(--border-subtle);
  overflow: hidden;
  position: relative;
}
.progress-bar {
  position: absolute;
  inset: 0;
  width: 25%;
  background: var(--stripe-running);
  border-radius: 1px;
}
.sweep-bar {
  animation: sweep 1.6s ease-in-out infinite;
}
</style>
