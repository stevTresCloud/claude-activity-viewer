/* ================================================================
 * vitest.config.ts — Configuración base de tests.
 *
 * Convenciones:
 *   - Default environment: `node`. Suficiente para bridge/runtime/zod.
 *   - Tests del webview (store + format helpers) declaran
 *     `// @vitest-environment happy-dom` al tope del archivo
 *     porque consumen Pinia + reactividad Vue que tocan APIs DOM
 *     mínimas (Element/window). Happy-dom es más liviano que jsdom
 *     y suficiente para el caso — no renderizamos componentes Vue
 *     en esta fase, solo activamos un store con setActivePinia.
 *
 *   - Alias `vscode` → src/__mocks__/vscode.ts: la extensión
 *     importa `vscode` runtime, pero ese módulo solo existe dentro
 *     del extension host de VS Code. En Node puro el resolver
 *     tiraría "Cannot find module 'vscode'". El mock ofrece la
 *     superficie mínima que el código bajo prueba consume
 *     (workspace.getConfiguration, workspace.workspaceFolders).
 *
 *   - Tests viven junto al código (`src/**\/__tests__/...`). El
 *     bundler de prod los excluye via tsconfig.
 * ================================================================ */

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/__tests__/**/*.test.ts'],
    // Sin retry: tests determinísticos por diseño. Si uno falla
    // en CI, queremos verlo, no esconderlo con un re-run.
    retry: 0,
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'src/__mocks__/vscode.ts'),
    },
  },
});
