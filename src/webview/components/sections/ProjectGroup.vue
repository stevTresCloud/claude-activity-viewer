<script setup lang="ts">
/**
 * ProjectGroup — wrapper card para los agentes de un mismo
 * project + task + branch + batchId.
 *
 * Estructura:
 *   <ProjectGroup>
 *     ← header del project group (slot "header")
 *     ← divider interno
 *     ← agent rows con dividers entre cada uno (slot default)
 *   </ProjectGroup>
 *
 * Los dividers entre agent rows los genera el padre usando la
 * pseudo-clase `:not(:last-child)` en cada row; este componente
 * solo separa header del primer agente con su propio `<hr>`.
 * Razón: si extraemos un `<AgentList>` para meter dividers, los
 * componentes hijos pierden control sobre el indent del stripe
 * left-border (que vive en cada AgentCard*).
 *
 * Referencia: HANDOFF.md §2.6.
 */
</script>

<template>
  <div class="group">
    <slot name="header" />
    <hr class="divider" />
    <div class="agents">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.group {
  background: var(--background-card);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 10px;
  /* Sin gap aquí; los hijos manejan su propio espacio para que el
   * divider quede pegado a las rows sin doble spacing. */
}

.divider {
  height: 1px;
  background: var(--border-subtle);
  border: none;
  margin: 8px 0;
}

/* === Agent rows container ===
 * Los gaps + dividers entre rows los maneja el padre vía
 * .agents > * + * (selector adjacency) en vez de gap fijo, así un
 * solo agent no genera espacio fantasma debajo. */
.agents {
  display: flex;
  flex-direction: column;
}
.agents > :deep(*) + :deep(*) {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
}
</style>
