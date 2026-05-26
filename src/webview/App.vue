<script setup lang="ts">
/**
 * App.vue — root del webview.
 *
 * Layout estable que cambia solo el body según el estado del
 * filtro y la presencia de agentes:
 *
 *   ┌─ Toolbar (siempre) ──────────────────────┐
 *   │   title + selector + context line cond.  │
 *   ├─ Body ───────────────────────────────────┤
 *   │   EmptyState (si no hay agentes)         │
 *   │     ↓ ó                                  │
 *   │   AllProjectsView  ↔  SingleProjectView  │
 *   └──────────────────────────────────────────┘
 *
 * El routing es un v-if simple sobre `selectedProjectId` del
 * composable useProjectFilter — no usamos vue-router porque solo
 * hay 2 estados y un router formal sería overhead.
 *
 * useDashboardBridge se invoca acá, UNA sola vez, para registrar
 * el listener global de postMessage del extension host. NO
 * invocar desde componentes hijos — el listener vive a nivel
 * window y duplicarlo dispararía cada action múltiples veces.
 */

import { useProjectFilter } from './composables/useProjectFilter';
import { useDashboardBridge } from './composables/useDashboardBridge';
import { useDetailMode } from './composables/useDetailMode';
import { useAgentsStore } from './stores/useAgentsStore';
import Toolbar from './components/Toolbar.vue';
import AllProjectsView from './views/AllProjectsView.vue';
import SingleProjectView from './views/SingleProjectView.vue';
import AgentDetailView from './views/AgentDetailView.vue';

const detail = useDetailMode();
const { selectedProjectId } = useProjectFilter();
const store = useAgentsStore();

// Wire del adapter postMessage → store. Hace addEventListener al
// mount, cleanup al unmount. Aplica en ambos modos (sidebar y
// detail) porque ambos webviews reciben los mismos eventos del
// bridge y necesitan poblar el mismo store local.
useDashboardBridge();
</script>

<template>
  <!-- Detail mode: editor tab abierto on-demand, renderea SOLO el
       AgentDetailView. No mostramos toolbar ni cards aquí. -->
  <AgentDetailView v-if="detail.mode === 'detail'" />

  <!-- Sidebar mode (default): dashboard completo. -->
  <main v-else class="container">
    <Toolbar />
    <div v-if="store.totalCount === 0" class="empty-state">
      <p class="empty-title">No agents yet.</p>
      <p class="empty-hint">
        Spawn agents from your Claude Code chat with the spawn_agents tool.
      </p>
    </div>
    <SingleProjectView v-else-if="selectedProjectId" />
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

/* === Empty state global ===
 * Versión mínima: texto centrado, sin CTA "Show how" (esa
 * variante con call-to-action queda para polish posterior).
 * Reusa los tokens semánticos para que respete el theme activo. */
.empty-state {
  padding: 48px 24px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty-title {
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 500;
  color: var(--foreground);
}

.empty-hint {
  font-family: var(--font-ui);
  font-size: 11px;
  color: var(--foreground-muted);
  line-height: 1.4;
}
</style>
