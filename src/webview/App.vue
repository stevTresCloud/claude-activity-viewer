<script setup lang="ts">
// Mientras dura esta sub-fase, App.vue renderea solo el showcase
// de átomos. En 1.3.c esto pasa a la vista real (sections + cards)
// y el showcase queda accesible para regression visual on-demand.

import AtomShowcase from './views/AtomShowcase.vue';
</script>

<template>
  <main
    class="container"
    :style="{
      background: 'var(--background-view)',
      color: 'var(--foreground)',
      fontFamily: 'var(--font-ui)',
    }"
  >
    <AtomShowcase />
  </main>
</template>

<style scoped>
.container {
  min-height: 100vh;
  padding: 12px;
}
</style>
