<script setup lang="ts">
/**
 * ContextBar — barra de progreso del context window del agente.
 *
 * Visual: track 6px gris claro + fill coloreado según umbral.
 *   - pct < 60%:  success (verde)
 *   - pct < 85%:  warning (amarillo)
 *   - else:       error   (rojo)
 *
 * Encima del track hay una label-row con "Context" a la izquierda
 * y el porcentaje (con tokens opcionales) a la derecha en
 * tabular-nums para que no baile cuando cambian dígitos.
 *
 * `contextTokens` y `tokensTotal` son opcionales; si vienen ambos
 * se muestra "{used}k / {total}k · {pct}%", si solo viene el pct
 * se muestra "{pct}%". Formato compacto para que no rompa en
 * sidebars angostos.
 *
 * Referencia: HANDOFF.md §2.11.
 */

import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    /** Porcentaje 0-100 del context usado. */
    pct: number;
    /**
     * Tokens cargados en el context window activo. Coincide
     * matemáticamente con `pct` (= contextTokens / tokensTotal *
     * 100). Cuando viene, mostramos `Xk / 200k · pct%`. Cuando no,
     * mostramos solo `pct%` — el agente recién spawneado no tiene
     * usage event aún, mostrar `0k / 200k · 0%` agrega ruido.
     *
     * NO confundir con `agent.tokensUsed` (= costo billable del
     * último turn) — ese se muestra en RECENT cards y completion
     * toast, no acá.
     */
    contextTokens?: number;
    /** Tokens máximos del context window (default 200k Claude). */
    tokensTotal?: number;
  }>(),
  { tokensTotal: 200_000 },
);

// === Color del fill por umbral ===
//
// 4 tramos:
//   < 60%  success (verde) — uso normal
//   < 85%  warning (amarillo) — el context se está llenando
//   < 95%  warning intensificado (naranja) — preventivo, cerca del límite
//   ≥ 95%  error (rojo) — riesgo de auto-truncate del SDK pronto
//
// El usuario rara vez ve naranja: el SDK Anthropic activa prompt-caching
// agresivo + auto-summary mucho antes; pero cuando aparece es señal real
// de que conviene cerrar el agente y arrancar uno nuevo.

const fillColor = computed(() => {
  if (props.pct < 60) return 'var(--color-success)';
  if (props.pct < 85) return 'var(--color-warning)';
  if (props.pct < 95) return 'rgb(255 140 0)';
  return 'var(--color-error)';
});

// === Format de la label derecha ===
//
// "116k / 200k · 58%"  cuando hay tokens
// "58%"                 cuando solo hay pct

const formatK = (n: number) => `${Math.round(n / 1000)}k`;

const labelRight = computed(() => {
  // contextTokens > 0 → versión larga "119k / 200k · 60%" que
  // matchea matemáticamente con el porcentaje. Si llega undefined
  // o 0 (agente recién spawneado, sin usage event aún) mostramos
  // solo el porcentaje — `0k / 200k · 0%` agrega ruido sin info útil.
  if (props.contextTokens !== undefined && props.contextTokens > 0) {
    return `${formatK(props.contextTokens)} / ${formatK(props.tokensTotal)} · ${props.pct}%`;
  }
  return `${props.pct}%`;
});

// Clamp defensivo — si el backend manda 105 evitamos overflow
// visual del fill. No corregimos el dato, solo el render.
const clampedPct = computed(() => Math.max(0, Math.min(100, props.pct)));

// Tooltip explicativo: el `contextUsedPct` confunde al user porque
// puede llegar a 80%+ con cost~0 (prompt cache hits son baratísimos).
// Aclaramos qué mide.
const tooltipText =
  'Percentage of the model context window used (input + cache read + ' +
  'cache creation). Prompt caching from Anthropic lets this go past 50% ' +
  'with near-zero cost — that is a feature of the platform, not a bug. ' +
  'Yellow at 60%, orange at 85% (preventive), red at 95% (close to limit).';
</script>

<template>
  <div class="context-bar" :title="tooltipText">
    <div class="label-row">
      <span class="label-text">Context</span>
      <span class="label-right">{{ labelRight }}</span>
    </div>
    <div class="track">
      <div
        class="fill"
        :style="{
          width: `${clampedPct}%`,
          background: fillColor,
        }"
      />
    </div>
  </div>
</template>

<style scoped>
.context-bar {
  display: flex;
  flex-direction: column;
  gap: 3px;
  /* width 100% para que `.label-row` con space-between separe
   * "Context" del porcentaje a los extremos del row. Sin esto el
   * componente solo ocupa el content-width y los dos labels quedan
   * pegados sin espacio entre ellos. */
  width: 100%;
}
.label-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.label-text,
.label-right {
  font-size: 11px;
  color: var(--foreground-muted);
}
.label-right {
  font-variant-numeric: tabular-nums;
}
.track {
  height: 6px;
  background: rgb(157 157 157 / 0.2);
  border-radius: 3px;
  overflow: hidden;
}
.fill {
  height: 100%;
  border-radius: 3px;
  transition:
    width 300ms ease,
    background-color 200ms ease;
}
</style>
