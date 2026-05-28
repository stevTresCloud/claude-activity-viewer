<script setup lang="ts">
/**
 * VerificationBadge — pill que indica si el agente pasó por Mecanismo
 * D + A (verification) y si el orchestrator lo promovió a needs_review.
 *
 * Estados (calculados desde props del Agent):
 *   - mode='none' o sin mode  → no renderiza nada (el agente no
 *                                pasó por verification, no hay
 *                                señal que mostrar).
 *   - reviewed=false           → "VERIFYING…" (italic dim) mientras
 *                                el critic Haiku está corriendo
 *                                post-fan-in. Estado raro: solo se
 *                                ve durante los ~30-60s del critic
 *                                cuando el wait_for_agents está vivo.
 *   - reviewed=true, !promoted → "✓ HAIKU OK" (verde). El orchestrator
 *                                pasó por D + A (según mode) y NO
 *                                encontró razón para promover.
 *   - reviewed=true, promoted  → "⚠ FLAGGED" (naranja). El orchestrator
 *                                promovió a needs_review (D detectó
 *                                decisions/uncertainties O critic Haiku
 *                                emitió 1+ flag).
 *
 * Diseño: hermano de PriorityPill / FailedBadge — mismo shape, 1px
 * 5px padding, 9.5px font, uppercase, font-weight 700. El color de
 * fondo es semi-transparent (rgb(.../0.15)) sobre el accent
 * correspondiente para no chocar con themes oscuros/claros.
 *
 * Variantes 'critic' / 'structured' / 'both' / 'human-review' del mode
 * NO se distinguen en el badge — el label "HAIKU" indica "verification
 * pasó", el detail panel muestra el bloque completo. Mantener el badge
 * simple para que no compita visualmente con priority/failed.
 */

import { computed } from 'vue';
import type { VerificationMode } from '../../../shared/dashboard-protocol';

const props = defineProps<{
  /** Modo de verification del agente. undefined o 'none' → no badge. */
  mode?: VerificationMode;
  /** El bridge marcó reviewed=true tras correr D + A. */
  reviewed?: boolean;
  /** El bridge promovió a needs_review (D o A disparó). */
  promoted?: boolean;
}>();

/**
 * Resuelve la variante visual a renderear. `'hidden'` corta el render
 * (el template usa v-if). Las otras 3 mapean a label + clase CSS.
 */
const variant = computed<'hidden' | 'verifying' | 'ok' | 'flagged'>(() => {
  if (!props.mode || props.mode === 'none') return 'hidden';
  if (!props.reviewed) return 'verifying';
  return props.promoted ? 'flagged' : 'ok';
});

const label = computed(() => {
  switch (variant.value) {
    case 'verifying':
      return 'verifying…';
    case 'ok':
      return '✓ Haiku OK';
    case 'flagged':
      return '⚠ Flagged';
    default:
      return '';
  }
});
</script>

<template>
  <span
    v-if="variant !== 'hidden'"
    class="verification-badge"
    :class="`is-${variant}`"
    :title="
      variant === 'verifying'
        ? 'Verification in progress (Mechanism D + A)'
        : variant === 'ok'
        ? 'Haiku critic reviewed the diff and found no concerns'
        : 'Promoted to needs_review by orchestrator (declared decisions/uncertainties or critic flagged)'
    "
  >{{ label }}</span>
</template>

<style scoped>
.verification-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  border-radius: 2px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  line-height: 1.4;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

/* "verifying" — italic + muted, indica que el critic está vivo. */
.is-verifying {
  background: rgb(125 125 125 / 0.12);
  color: var(--foreground-muted);
  font-style: italic;
  text-transform: none;
}

/* "ok" — verde, mismo color del stripe-done. */
.is-ok {
  background: rgb(76 175 80 / 0.15);
  color: var(--color-success, #4caf50);
}

/* "flagged" — naranja, mismo accent que PriorityPill HIGH. */
.is-flagged {
  background: rgb(255 152 0 / 0.18);
  color: var(--color-warning, #ff9800);
}
</style>
