/* ================================================================
 * detail-panel.test.ts — Tests del DetailPanelManager.
 *
 * Cubre las 3 ramas de `showForAgent`:
 *   1. agentId vacío → rechaza sin crear panel + loggea.
 *   2. no hay panel previo → crea uno fresco vía createWebviewPanel.
 *   3. ya hay panel para el MISMO agente → reveal del existente,
 *      sin dispose ni crear uno nuevo.
 *   4. ya hay panel para OTRO agente → dispose del viejo + crea
 *      uno nuevo para el nuevo agente.
 *
 * El cuarto caso es el que justifica más cobertura: el bug típico
 * sería dejar el panel viejo vivo y crear uno duplicado, o no
 * actualizar `currentAgentId` y caer en un estado inconsistente.
 *
 * Fakes:
 *   - `vscode.window.createWebviewPanel` viene del mock global en
 *     `__mocks__/vscode.ts`, captura cada panel creado en una cola
 *     inspectable via `__getWebviewPanels()`.
 *   - `fs.readFileSync` se mockea localmente para devolver un HTML
 *     mínimo (el builder real lo lee del bundle Vite que no existe
 *     en el contexto del test).
 *   - `bridge.attachWebview` / `detachWebview` se fakean con spies;
 *     solo importa que se llamen, no la integración real.
 * ================================================================ */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:fs ANTES del import del SUT — el SUT importa
// buildWebviewHtml que llama fs.readFileSync(indexPath) al
// construir el HTML. Sin este stub el test explota con ENOENT.
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => '<html><head></head><body></body></html>'),
}));

import { DetailPanelManager } from '../detail-panel';
import type { DashboardBridge } from '../../dashboard/bridge';
import { __getWebviewPanels, __resetVscode } from '../../__mocks__/vscode';
import { makeOutputChannel } from '../../dashboard/__tests__/_fixtures';

function makeBridge() {
  return {
    attachWebview: vi.fn((webview: unknown) => webview),
    detachWebview: vi.fn(),
    hydrateLogs: vi.fn(),
    hydrateMetrics: vi.fn(async () => undefined),
  } as unknown as DashboardBridge;
}

function makeManager() {
  const extensionUri = { fsPath: '/ext', toString: () => '/ext' };
  const bridge = makeBridge();
  const channel = makeOutputChannel();
  const onMessage = vi.fn();
  const manager = new DetailPanelManager(
    extensionUri as never,
    bridge,
    channel as never,
    onMessage,
  );
  return { manager, bridge, channel, onMessage };
}

describe('DetailPanelManager · showForAgent', () => {
  beforeEach(() => {
    __resetVscode();
  });

  it('rechaza agentId vacío sin crear panel', () => {
    const { manager, bridge, channel } = makeManager();
    manager.showForAgent('', 'unused');
    expect(__getWebviewPanels()).toHaveLength(0);
    expect(bridge.attachWebview).not.toHaveBeenCalled();
    // El reject va al OutputChannel para diagnóstico.
    expect(channel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('reject show: empty agentId'),
    );
  });

  it('sin panel previo crea uno fresco y lo attache al bridge', () => {
    const { manager, bridge } = makeManager();
    manager.showForAgent('agent-1', 'my-agent');
    const panels = __getWebviewPanels();
    expect(panels).toHaveLength(1);
    expect(panels[0].title).toBe('Agent: my-agent');
    expect(panels[0].disposed).toBe(false);
    expect(bridge.attachWebview).toHaveBeenCalledTimes(1);
  });

  it('mismo agentId que el panel actual hace reveal, no crea uno nuevo', () => {
    const { manager, bridge } = makeManager();
    manager.showForAgent('agent-1', 'my-agent');
    const firstPanel = __getWebviewPanels()[0];
    expect(firstPanel.reveal).not.toHaveBeenCalled();

    // Segunda llamada al MISMO agentId — debe reusar el panel.
    manager.showForAgent('agent-1', 'my-agent');
    expect(__getWebviewPanels()).toHaveLength(1);
    expect(firstPanel.reveal).toHaveBeenCalledTimes(1);
    expect(firstPanel.disposed).toBe(false);
    // attachWebview solo se llamó UNA vez (en la primera apertura).
    expect(bridge.attachWebview).toHaveBeenCalledTimes(1);
  });

  it('distinto agentId dispone el panel viejo y crea uno nuevo', () => {
    const { manager, bridge } = makeManager();
    manager.showForAgent('agent-1', 'first-agent');
    const firstPanel = __getWebviewPanels()[0];

    // Cambiar de agente — debe disponer el viejo y crear un fresco.
    manager.showForAgent('agent-2', 'second-agent');
    const panels = __getWebviewPanels();
    expect(panels).toHaveLength(2);
    expect(firstPanel.disposed).toBe(true);
    expect(panels[1].title).toBe('Agent: second-agent');
    expect(panels[1].disposed).toBe(false);
    // bridge.attachWebview se llama 2 veces (una por panel).
    expect(bridge.attachWebview).toHaveBeenCalledTimes(2);
    // bridge.detachWebview se llama UNA vez (cuando el viejo se
    // dispose dispara el onDidDispose handler).
    expect(bridge.detachWebview).toHaveBeenCalledTimes(1);
  });
});
