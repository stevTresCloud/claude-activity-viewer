<script setup lang="ts">
/**
 * AgentCardRunningStandalone — variante "card propio" del running
 * agent card, usada en la vista Single project (sin project group
 * container que lo envuelva).
 *
 * Diferencias con AgentCardRunning (HANDOFF §2.8.2):
 *
 *   - Lleva su propio background + border + border-radius 6px (el
 *     hermano hereda eso del container del project group).
 *   - El border-left 3px running ahora vive en el container padre,
 *     no en cada line.
 *   - El sweeping progress bar va `position: absolute` full-width
 *     abajo del card (no inline en el row de actions). Cubre todo
 *     el ancho del card, dándole un sentido visual más fuerte de
 *     "este card está procesando".
 *   - Padding 12px para que las 4 líneas respiren más sin el
 *     padding del container.
 *
 * Las 4 líneas internas son idénticas al hermano y reusan los
 * mismos átomos (StatusDot pulse, ModelBadge, ContextBar) — solo
 * el wrapper cambia. La decisión de NO parametrizar con un prop
 * `standalone` boolean en AgentCardRunning fue para evitar un
 * componente con 4 estilos en cascada según un boolean — lee mejor
 * tener dos archivos pequeños con scope claro.
 *
 * Referencia: HANDOFF.md §2.8.2.
 */

import { computed } from 'vue';
import type { Agent } from '../../types';
import { formatElapsed } from '../../utils/format';
import { useNow } from '../../composables/useNow';
import StatusDot from '../atoms/StatusDot.vue';
import ContextBar from '../atoms/ContextBar.vue';
import ModelBadge from '../atoms/ModelBadge.vue';
import AgentActionRow from './AgentActionRow.vue';

const props = defineProps<{
  agent: Agent;
}>();

// elapsed deriva de useNow() — el wire trae startedAtIso absoluto
// y la card hace la diferencia local cada tick. Misma lógica que
// AgentCardRunning (variante in-group); ver explicación allí.
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

    <!-- === L4: actions sin sweep inline (sweep va absolute abajo) === -->
    <div class="line indented actions">
      <AgentActionRow :agent="agent" />
    </div>

    <!-- === Sweep bar full-width pegado al borde inferior del card === -->
    <div class="sweep-track">
      <div class="sweep-bar" />
    </div>
  </div>
</template>

<style scoped>
/* === Card padre — bg + border + radius + stripe izquierda === */
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--background-card);
  border: 1px solid var(--border-subtle);
  /* La stripe vive en el border-left del card; los hijos NO la
   * llevan repetida como en la variante "dentro de project group". */
  border-left: 3px solid var(--stripe-running);
  border-radius: 6px;
  padding: 12px;
  /* overflow:hidden para que el sweep bar no se salga del radius
   * del card en su esquina inferior. */
  overflow: hidden;
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

/* === L2/L3/L4 — indent debajo del dot 7px + gap 6px === */
.indented {
  padding-left: 13px;
}

/* === L2 — subtitle muted, tool con foreground === */
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

/* === L4 — actions container (AgentActionRow trae los 3 botones) === */
.actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* === Sweep bar full-width pegado abajo del card (HANDOFF §2.8.2) === */
.sweep-track {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  overflow: hidden;
}
.sweep-bar {
  position: absolute;
  inset: 0;
  width: 25%;
  background: var(--stripe-running);
  animation: sweep 1.6s ease-in-out infinite;
}
</style>
