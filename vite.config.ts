/**
 * Build del webview de Claude Orchestrator.
 *
 * Bundlea `src/webview/` (Vue 3 + Pinia + Tailwind v4) a `out/webview/`.
 * Corre separado del esbuild del extension host porque target, module
 * format y plugins son distintos: el host es CJS Node20, el webview es
 * ESM con Vue SFC compilados.
 */

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  // === Raíz del proyecto webview ===
  // Vite resuelve index.html y imports relativos contra este root.
  root: resolve(__dirname, 'src/webview'),

  // base relativo: los assets emitidos referencian "./assets/..." en vez
  // de absolutos "/assets/...". Necesario porque el extension host
  // reescribe los paths a URIs `vscode-webview://` en tiempo de carga.
  base: './',

  plugins: [vue(), tailwindcss()],

  build: {
    outDir: resolve(__dirname, 'out/webview'),
    // Solo limpia esta subcarpeta, no toca out/extension.js del esbuild.
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Sin hash: el extension host lee out/webview/index.html y
        // reescribe paths de assets — necesitamos nombres predecibles.
        // El cache-busting no aplica acá porque el webview es local.
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
