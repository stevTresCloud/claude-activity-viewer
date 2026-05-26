<script setup lang="ts">
/**
 * StatusDot — dot 7px que indica estado.
 *
 * Dos formas visuales:
 *   - filled: círculo lleno con `background`. Usado para running,
 *     done, active, failed, etc.
 *   - ring:   círculo outlined (border 1.5px sin fill). Usado para
 *     project lifecycle idle / inactive en el dropdown selector.
 *
 * El color se elige según el `status` y mapea a las CSS vars del
 * @theme. El prop `pulse` agrega la animación `pulse` (definida en
 * style.css) + un halo difuso con box-shadow — usado solo en el
 * status running de NOW PLAYING.
 *
 * Referencia: HANDOFF.md §3.1 (Custom dots SVG inline).
 */

import { computed } from 'vue';
import type { AgentStatus, ProjectLifecycle } from '../../types';

type DotKind = AgentStatus | ProjectLifecycle;

const props = withDefaults(
  defineProps<{
    /** Estado del agente o lifecycle del proyecto. */
    status: DotKind;
    /** Si true, anima con pulse + halo. Solo aplica a kinds filled. */
    pulse?: boolean;
  }>(),
  { pulse: false },
);

// === Mapeo status → variante visual ===
//
// `idle` / `inactive` son los únicos rings; el resto va filled. El
// color del fill (o del border en rings) lo da `dotColor`.

const isRing = computed(() => props.status === 'idle' || props.status === 'inactive');

const dotColor = computed(() => {
  switch (props.status) {
    case 'running':
    case 'done':
    case 'active':
      return 'var(--color-success)';
    case 'pending':
      return 'var(--color-warning)';
    case 'failed':
      return 'var(--color-error)';
    case 'cancelled':
    case 'idle':
    case 'inactive':
      return 'var(--color-muted)';
    default:
      return 'var(--color-muted)';
  }
});

/**
 * Halo del pulse — derivado del color del dot con alpha. Si en el
 * futuro queremos otros halos (warning halo para pending dots
 * animados, por ejemplo) este `computed` se extiende.
 */
const haloColor = computed(() => {
  // Hardcoded a la versión success para el único caso pulse de
  // ahora (NOW PLAYING running dot). En 1.3.c si hay pulse para
  // otros estados se generaliza.
  return 'rgb(76 175 80 / 0.3)';
});
</script>

<template>
  <span
    class="dot"
    :class="{ 'dot-ring': isRing, 'dot-pulse': pulse && !isRing }"
    :style="{
      background: isRing ? 'transparent' : dotColor,
      border: isRing ? `1.5px solid ${dotColor}` : 'none',
      boxShadow: pulse && !isRing ? `0 0 0 3px ${haloColor}` : 'none',
    }"
    :aria-label="`status ${status}`"
  />
</template>

<style scoped>
.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot-pulse {
  animation: pulse 1.8s ease-in-out infinite;
}
</style>
