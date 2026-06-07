/* ================================================================
 * useDetailMode.ts — Lee el modo de boot del webview.
 *
 * El bundle Vite del webview es UNO solo, pero se monta en dos
 * contextos distintos:
 *
 *   - **Sidebar** (`mode='sidebar'`): el dashboard completo con
 *     cards, toolbar, scanner, etc. Default.
 *   - **Detail** (`mode='detail'`): un editor tab abierto on-demand
 *     para mostrar el stream live de UN agente específico. Trae
 *     también `agentId` inyectado.
 *
 * El extension host decide el modo al construir el HTML del webview
 * y lo inyecta antes del bundle como un `<script nonce>` que setea
 * `window.__claudeOrchestrator = { mode, agentId? }`. Esta función
 * lo lee y normaliza para que el resto del código Vue lo consuma
 * tipado.
 *
 * El DetailPanelManager dispose+recrea el panel cuando el user
 * selecciona otro agente desde el sidebar — el nuevo HTML llega
 * con el `agentId` actualizado en `window.__claudeOrchestrator`.
 * Por eso este composable solo lee el valor inicial; no hay
 * protocolo "set_agent" mid-life.
 * ================================================================ */

interface DetailModeConfig {
  mode: 'sidebar' | 'detail';
  agentId: string | null;
}

declare global {
  interface Window {
    __claudeOrchestrator?: {
      mode?: string;
      agentId?: string | null;
    };
  }
}

/**
 * Resuelve el modo de arranque del webview. Default `sidebar`
 * cuando no hay inyección (preview standalone Vite / tests
 * happy-dom / extension host viejo sin inyección).
 */
export function useDetailMode(): DetailModeConfig {
  const cfg = typeof window !== 'undefined' ? window.__claudeOrchestrator : undefined;
  const mode = cfg?.mode === 'detail' ? 'detail' : 'sidebar';
  const agentId = mode === 'detail' && typeof cfg?.agentId === 'string' ? cfg.agentId : null;
  return { mode, agentId };
}
