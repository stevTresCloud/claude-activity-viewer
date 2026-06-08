/* ================================================================
 * usePostToExtension.ts — Wrapper de `vscode.postMessage(...)`.
 *
 * En un webview de VS Code, el handle se obtiene con
 * `acquireVsCodeApi()` UNA sola vez por instancia (segundo
 * llamado tira). Lo cacheamos en module scope y exponemos
 * `postToExtension(event)` para que cualquier componente lo use
 * sin manejar el ciclo de vida del handle.
 *
 * Si `acquireVsCodeApi` no existe (test environment con happy-dom
 * o standalone preview de Vite), exponemos un no-op que loggea al
 * console — los componentes siguen funcionando sin tirar.
 *
 * Tipos: el evento debe pertenecer al union
 * `DashboardEventToExtension` del contrato compartido. Esto
 * garantiza que cualquier `postToExtension({...})` rompe la
 * compilación si no respeta el shape esperado por el bridge.
 * ================================================================ */

import type { DashboardEventToExtension } from '../../shared/dashboard-protocol';

// === Tipo mínimo del handle que VS Code expone al webview ===

interface VsCodeWebviewHandle {
  postMessage(payload: unknown): void;
}

declare global {
  /**
   * `acquireVsCodeApi` solo existe dentro del runtime de un webview
   * de VS Code. Declarado como global para que TS no se queje en
   * el archivo que sí lo usa.
   */
  interface Window {
    acquireVsCodeApi?: () => VsCodeWebviewHandle;
  }
}

// === Cache del handle ===
//
// `acquireVsCodeApi()` solo puede llamarse UNA vez por webview;
// el segundo intento tira "An instance of the VS Code API has
// already been acquired". El cache module-level garantiza que
// nuestro código no caiga en esa trampa.

let cachedHandle: VsCodeWebviewHandle | null = null;
let handleResolved = false;

function getHandle(): VsCodeWebviewHandle | null {
  if (handleResolved) return cachedHandle;
  handleResolved = true;
  try {
    if (typeof window !== 'undefined' && window.acquireVsCodeApi) {
      cachedHandle = window.acquireVsCodeApi();
    }
  } catch {
    // En tests / preview standalone el handle no existe; dejamos
    // null y los callers caen al no-op.
    cachedHandle = null;
  }
  return cachedHandle;
}

/**
 * Envía un evento tipado al extension host. Si el handle no está
 * disponible (test env, preview), loggea al console pero no tira.
 *
 * Forma idiomática:
 *
 *   postToExtension({ type: 'request_rescan' });
 *   postToExtension({ type: 'request_resume_session', sessionId, cwd });
 *
 * El bridge del extension host hace `switch (msg.type)` y narrow-a
 * cada case sin casts (mismo patrón que del lado webview).
 */
export function postToExtension(event: DashboardEventToExtension): void {
  const handle = getHandle();
  if (!handle) {
    // Sin tirar — los tests / standalone preview no tienen VS Code.
    // eslint-disable-next-line no-console
    console.warn('[claude-activity-viewer] postToExtension noop (no VS Code handle):', event);
    return;
  }
  handle.postMessage(event);
}
