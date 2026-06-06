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
 *       L4: AgentActionRow (pause/cancel/open) + sweeping bar
 *
 * El `margin-left: -2px` alinea el stripe con el borde izquierdo del
 * container del project group (que tiene padding 10px). Sin el
 * margin, la stripe queda 2px adentro y se nota un escalón.
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
import { useShowDetail } from '../../composables/useShowDetail';
import { useAgentsStore } from '../../stores/useAgentsStore';
import StatusDot from '../atoms/StatusDot.vue';
import ContextBar from '../atoms/ContextBar.vue';
import ModelBadge from '../atoms/ModelBadge.vue';
import AgentActionRow from './AgentActionRow.vue';

const props = defineProps<{
  agent: Agent;
}>();

// Liveness: el agente sigue en NOW PLAYING pero lleva un rato sin
// eventos de hook. No lo sacamos (puede estar en una tool larga); solo
// frenamos el pulse/sweep y mostramos "idle" para no fingir actividad.
const store = useAgentsStore();
const isStale = computed(() => store.staleAgentIds.has(props.agent.id));

// Click en el body de la card (no en botones de AgentActionRow,
// que llevan @click.stop) abre el detail panel en un editor tab.
const detail = useShowDetail();
function onBodyClick(): void {
  detail.show(props.agent.id);
}

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
  <div
    class="card"
    role="button"
    :aria-label="`Open ${agent.name} detail view`"
    tabindex="0"
    @click="onBodyClick"
    @keydown.enter="onBodyClick"
    @keydown.space.prevent="onBodyClick"
  >
    <!-- === L1: dot + name + model + elapsed === -->
    <div class="line line-1">
      <StatusDot status="running" :pulse="!isStale" />
      <span class="name">{{ agent.name }}</span>
      <ModelBadge v-if="agent.model" :model="agent.model" />
      <span v-if="isStale" class="stale-hint" title="No recent hook activity">idle</span>
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
      <ContextBar :pct="agent.contextUsedPct" :context-tokens="agent.contextTokens" />
    </div>

    <!-- === L4: actions + sweeping progress bar inline ===
         El sweep ocupa el espacio sobrante a la derecha de los 3
         botones (flex:1). -->
    <div class="line indented actions">
      <AgentActionRow :agent="agent" />
      <div class="progress-track">
        <div class="progress-bar sweep-bar" :class="{ paused: isStale }" />
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
  /* Click-through al detail panel. Cursor pointer en toda la card
   * excepto los botones de AgentActionRow (que llevan @click.stop). */
  cursor: pointer;
}
.card:hover {
  background: var(--card-hover-bg-subtle);
}
.card:focus-visible {
  outline: var(--card-focus-outline-width) solid var(--card-focus-outline-color);
  outline-offset: var(--card-focus-outline-offset);
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

/* Hint "idle" cuando el agente lleva sin eventos > umbral de staleness. */
.stale-hint {
  font-size: 10px;
  color: var(--foreground-muted);
  font-style: italic;
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

/* === L4 — actions container ===
 * AgentActionRow ya trae los 3 botones; acá solo el contenedor flex
 * con gap y el track del sweep bar que llena el espacio sobrante. */
.actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Sweeping bar: track 2px que toma el espacio sobrante (flex:1) a
 * la derecha de los 3 botones. El bar interno tiene width 25% del
 * track y se desplaza con keyframes `sweep` (style.css). */
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
/* Agente stale: congelamos el sweep para no fingir progreso activo. */
.sweep-bar.paused {
  animation-play-state: paused;
  opacity: 0.4;
}
</style>
