/* ================================================================
 * _fixtures.ts — Helpers reusables para tests del dashboard.
 *
 * Los tres tests del dashboard (bridge, scanner-controller, futuros
 * controllers) reusan el mismo shape de fakes: ExtensionContext con
 * globalState Map-backed + OutputChannel que solo absorbe
 * appendLine. Extracción para evitar copy-paste byte-a-byte.
 *
 * NO acoplan al DashboardBridge ni al ScannerController — son
 * shapes del namespace `vscode` que cualquier consumidor del
 * extension host necesita simular en tests sin DOM.
 * ================================================================ */

import { vi } from 'vitest';

/**
 * Fake ExtensionContext con `globalState` respaldado por Map en
 * memoria. Cubre las APIs que el bridge + scanner-controller
 * consumen (get, update, keys). Cada test recibe instancia fresca.
 */
export function makeContext() {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get<T>(key: string, defaultValue?: T): T {
        return store.has(key) ? (store.get(key) as T) : (defaultValue as T);
      },
      update(key: string, value: unknown): Thenable<void> {
        store.set(key, value);
        return Promise.resolve();
      },
      keys(): readonly string[] {
        return [...store.keys()];
      },
    },
  };
}

/**
 * Fake OutputChannel: solo necesita absorber appendLine (los logs
 * del bridge/controller van acá). Los otros métodos son spies vacíos
 * para que el TypeScript narrowing acepte la fixture como
 * `vscode.OutputChannel` cuando se castea con `as never`.
 */
export function makeOutputChannel() {
  return {
    appendLine: vi.fn<(line: string) => void>(),
    append: vi.fn<(s: string) => void>(),
    clear: vi.fn<() => void>(),
    show: vi.fn<() => void>(),
    hide: vi.fn<() => void>(),
    dispose: vi.fn<() => void>(),
    name: 'test',
    replace: vi.fn(),
  };
}
