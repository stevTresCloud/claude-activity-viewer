<script setup lang="ts">
/**
 * ModelBadge — pill que muestra el modelo del agente.
 *
 * Crítico HANDOFF §2.12: `white-space: nowrap` para que "Opus 4.7"
 * no se parta en dos líneas dentro del header de una agent card.
 * Sin esto, sidebars angostos rompen el layout de NOW PLAYING.
 *
 * `flex-shrink: 0` para que un nombre de agente largo no aplaste
 * la badge — primero se trunca el nombre, el modelo queda intacto.
 *
 * Referencia: HANDOFF.md §2.12.
 */

defineProps<{
  /** Display string del modelo: "Opus 4.7", "Sonnet", etc. */
  model: string;
}>();
</script>

<template>
  <span class="model-badge">{{ model }}</span>
</template>

<style scoped>
.model-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  background: var(--background-badge);
  color: var(--foreground);
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  font-family: var(--font-ui);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
  flex-shrink: 0;
}
</style>
