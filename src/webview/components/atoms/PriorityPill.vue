<script setup lang="ts">
/**
 * PriorityPill — pill LOW / MED / HIGH para agentes pending.
 *
 * 3 variantes con background `rgb(... / 0.15)` sobre los colores
 * semánticos del @theme. Los alphas hardcodeados son intencionales:
 * Tailwind v4 no permite componer `rgb()` con CSS vars como
 * componentes individuales sin un alias por canal — y mantener
 * legibles "rgb(255 152 0 / 0.15)" sobre el resto del diseño vale
 * más que la abstracción. Documentado también en HANDOFF §2.13.
 *
 * Referencia: HANDOFF.md §2.13.
 */

import { computed } from 'vue';
import type { Priority } from '../../types';

const props = defineProps<{
  priority: Priority;
}>();

// === Mapeo priority → estilos ===
//
// `text` se traduce desde el enum porque el render literal del
// prop (`HIGH`) ya está en mayúsculas, pero centramos el mapping
// para que cambiar la fuente del enum (ej. 'high'/'med'/'low') no
// rompa el render.

const styles = computed(() => {
  switch (props.priority) {
    case 'HIGH':
      return {
        background: 'rgb(255 152 0 / 0.15)',
        color: 'var(--color-warning)',
      };
    case 'MED':
      return {
        background: 'rgb(33 150 243 / 0.15)',
        color: 'var(--color-info)',
      };
    case 'LOW':
    default:
      return {
        background: 'rgb(157 157 157 / 0.18)',
        color: 'var(--color-muted)',
      };
  }
});
</script>

<template>
  <span class="priority-pill" :style="styles">{{ priority }}</span>
</template>

<style scoped>
.priority-pill {
  display: inline-flex;
  padding: 1px 5px;
  border-radius: 2px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  flex-shrink: 0;
  line-height: 1.4;
}
</style>
