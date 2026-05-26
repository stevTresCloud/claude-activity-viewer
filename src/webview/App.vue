<script setup lang="ts">
// App.vue — root del webview.
//
// 1.3.c rota el render del AtomShowcase a la vista All projects.
// AtomShowcase queda en disco (src/webview/views/AtomShowcase.vue)
// para usar como regression visual on-demand si se tocan átomos.

import AllProjectsView from './views/AllProjectsView.vue';
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
    <AllProjectsView />
  </main>
</template>

<style scoped>
/* El padding interno de cada bloque lo manejan los componentes
 * (toolbar trae su propio padding, section-body trae el suyo).
 * Acá solo garantizamos altura completa del viewport. */
.container {
  min-height: 100vh;
}
</style>
