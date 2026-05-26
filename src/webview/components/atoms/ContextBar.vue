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
 * `tokensUsed` y `tokensTotal` son opcionales; si vienen ambos se
 * muestra "{used}k / {total}k · {pct}%", si solo viene el pct se
 * muestra "{pct}%". Formato compacto para que no rompa en sidebars
 * angostos.
 *
 * Referencia: HANDOFF.md §2.11.
 */

import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    /** Porcentaje 0-100 del context usado. */
    pct: number;
    /** Tokens usados, opcional. Se muestra solo si ambos vienen. */
    tokensUsed?: number;
    /** Tokens máximos del context window (default 200k Claude). */
    tokensTotal?: number;
  }>(),
  { tokensTotal: 200_000 },
);

// === Color del fill por umbral ===

const fillColor = computed(() => {
  if (props.pct < 60) return 'var(--color-success)';
  if (props.pct < 85) return 'var(--color-warning)';
  return 'var(--color-error)';
});

// === Format de la label derecha ===
//
// "116k / 200k · 58%"  cuando hay tokens
// "58%"                 cuando solo hay pct

const formatK = (n: number) => `${Math.round(n / 1000)}k`;

const labelRight = computed(() => {
  if (props.tokensUsed !== undefined) {
    return `${formatK(props.tokensUsed)} / ${formatK(props.tokensTotal)} · ${props.pct}%`;
  }
  return `${props.pct}%`;
});

// Clamp defensivo — si el backend manda 105 evitamos overflow
// visual del fill. No corregimos el dato, solo el render.
const clampedPct = computed(() => Math.max(0, Math.min(100, props.pct)));
</script>

<template>
  <div class="context-bar">
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
