<script setup lang="ts">
// Foundation: smoke mínimo. Solo el <h1> con tokens VS Code para
// validar que Vue + Vite + Tailwind v4 + @theme + WebviewView funcionan
// end-to-end. Componentes reales entran en 1.3.b (atoms + store).
</script>

<template>
  <main
    class="min-h-screen p-3"
    :style="{
      background: 'var(--background-view)',
      color: 'var(--foreground)',
      fontFamily: 'var(--font-ui)',
    }"
  >
    <h1 class="text-base font-semibold">Claude Orchestrator</h1>
  </main>
</template>
