<script setup lang="ts">
/**
 * App.vue — root del webview.
 *
 * Layout estable que cambia solo el body según el estado del
 * filtro:
 *
 *   ┌─ Toolbar (siempre) ──────────────────────┐
 *   │   title + selector + context line cond.  │
 *   ├─ Body ───────────────────────────────────┤
 *   │   AllProjectsView  ↔  SingleProjectView  │
 *   └──────────────────────────────────────────┘
 *
 * El routing es un v-if simple sobre `selectedProjectId` del
 * composable useProjectFilter — no usamos vue-router porque solo
 * hay 2 estados y un router formal sería overhead. Si la
 * navegación se vuelve más rica en v0.2 (Projects screen) sí se
 * justifica el router.
 *
 * La Toolbar vive acá (no en cada vista) para que el ProjectSelector
 * mantenga su estado al rotar — el popover NO se cierra solo por
 * cambiar de vista.
 */

import { useProjectFilter } from './composables/useProjectFilter';
import Toolbar from './components/Toolbar.vue';
import AllProjectsView from './views/AllProjectsView.vue';
import SingleProjectView from './views/SingleProjectView.vue';

const { selectedProjectId } = useProjectFilter();
</script>

<template>
  <main class="container">
    <Toolbar />
    <SingleProjectView v-if="selectedProjectId" />
    <AllProjectsView v-else />
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
