<script setup lang="ts">
/**
 * SectionHeader — header colapsable de una de las 3 secciones del
 * dashboard (NOW PLAYING / UP NEXT / RECENT).
 *
 * Layout (HANDOFF §2.5):
 *   [chevron] [dot opcional] LABEL UPPERCASE      [N FAILED] (N)
 *
 * El componente NO gestiona el estado expandido: lo recibe via prop
 * y emite `toggle` al click. Esto deja la lógica de qué sección está
 * abierta en el padre (AllProjectsView), que arranca con NOW/UP
 * expandidas y RECENT colapsada por default.
 *
 * Sin animación height — la transición visual del body es trabajo
 * de polish futuro. Por ahora colapsar = `v-if` directo.
 *
 * Referencia: HANDOFF.md §2.5.
 */

import { computed } from 'vue';
import StatusDot from '../atoms/StatusDot.vue';
import FailedBadge from '../atoms/FailedBadge.vue';

export type SectionKind = 'NOW PLAYING' | 'UP NEXT' | 'RECENT' | 'PAST SESSIONS';

const props = withDefaults(
  defineProps<{
    kind: SectionKind;
    count: number;
    /** Solo aplica a RECENT — el badge se autoesconde si es 0. */
    failedCount?: number;
    /** Estado actual (controlado por el padre). */
    expanded: boolean;
  }>(),
  { failedCount: 0 },
);

defineEmits<{
  (event: 'toggle'): void;
}>();

// === Dot a la izquierda del label ===
//
// El HANDOFF pone un dot pulsando en NOW PLAYING (running) y un dot
// estático warning en UP NEXT (pending). RECENT no lleva dot — el
// estado ya no es "en curso", basta el FailedBadge cuando aplique.

const dotKind = computed(() => {
  if (props.kind === 'NOW PLAYING') return 'running' as const;
  if (props.kind === 'UP NEXT') return 'pending' as const;
  return null;
});

const dotPulse = computed(() => props.kind === 'NOW PLAYING');
</script>

<template>
  <button
    type="button"
    class="section-header"
    :aria-expanded="expanded"
    @click="$emit('toggle')"
  >
    <!-- chevron — rotación CSS controla expanded/collapsed -->
    <span class="chevron" :class="{ 'chevron-open': expanded }">
      <i class="codicon codicon-chevron-right" />
    </span>

    <!-- dot opcional (solo NOW PLAYING / UP NEXT) -->
    <StatusDot v-if="dotKind" :status="dotKind" :pulse="dotPulse" />

    <span class="label">{{ kind }}</span>

    <FailedBadge v-if="failedCount" :count="failedCount" />
    <span class="count">({{ count }})</span>
  </button>
</template>

<style scoped>
/* === Container — botón clickable full-width === */
.section-header {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-top: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--foreground-muted);
  cursor: pointer;
  text-align: left;
  font-family: var(--font-ui);
}
.section-header:hover {
  /* Highlight sutil — HANDOFF §2.5 */
  background: rgb(255 255 255 / 0.04);
}
.section-header:focus-visible {
  outline: 1px solid var(--focus-ring);
  outline-offset: -1px;
}

/* === Chevron === */
.chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  color: var(--foreground-muted);
  transform: rotate(0deg);
  transition: transform 200ms ease;
}
.chevron-open {
  /* chevron-right → chevron-down via rotación, evita cambiar el
   * codicon en runtime. */
  transform: rotate(90deg);
}
.chevron .codicon {
  font-size: 9px;
  line-height: 1;
}

/* === Label === */
.label {
  flex: 1;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
}

/* === Counter (N) === */
.count {
  font-size: 11px;
  font-weight: 600;
  color: var(--foreground-muted);
  font-variant-numeric: tabular-nums;
}
</style>
