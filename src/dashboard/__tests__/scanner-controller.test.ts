/* ================================================================
 * scanner-controller.test.ts — Tests del despachador webview→ext.
 *
 * Cubre los handlers `request_cancel` y `request_open` del
 * ScannerController + las branches del modal de confirmación.
 *
 * Decisiones de testing:
 *   - NO llamamos `start()` del controller en estos tests: arrancar
 *     el scanner dispara `scanProjects` + `scanSessions` sobre el
 *     filesystem real (lectura de `~/.claude/projects/`). Lo que nos
 *     interesa es el switch de `handleMessage`, no el lifecycle.
 *   - `bridge` se reemplaza por un `FakeBridge` mínimo con un
 *     `cancel` espiable. Mantener la fachada chica evita arrastrar
 *     el grafo entero del DashboardBridge real.
 *   - `vscode.window.showWarningMessage` lo absorbe el mock manual:
 *     `__setWarningChoice('Cancel agent')` simula el click en el
 *     botón del modal; `undefined` simula dismiss.
 * ================================================================ */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScannerController } from '../scanner-controller';
import {
  __getExecutedCommands,
  __getInfoCalls,
  __getWarningCalls,
  __resetVscode,
  __setConfig,
  __setWarningChoice,
  __setWorkspaceFolders,
} from '../../__mocks__/vscode';
import type { DashboardBridge } from '../bridge';
import { makeContext, makeOutputChannel } from './_fixtures';

// =====================================================================
// === Helpers de test =================================================
// =====================================================================

/**
 * FakeBridge — implementación mínima de la fachada que el
 * scanner-controller consume. Lo único que importa para los tests
 * de `request_cancel` es `cancel(agentId)`. Los otros métodos
 * (`emit`, `onAttach`) son stubs sin asserciones.
 */
function makeBridge() {
  return {
    cancel: vi.fn<(agentId: string) => boolean>(() => true),
    emit: vi.fn(),
    onAttach: vi.fn<(cb: () => void) => () => void>(() => () => {}),
    /**
     * El handler `request_open` lo consulta para obtener cwd +
     * sessionId del agente vivo. Default: agente desconocido. Tests
     * que prueban el happy path usan `bridge.getResumeTarget.mockReturnValueOnce(...)`.
     */
    getResumeTarget: vi.fn<
      (agentId: string) =>
        | { sessionId?: string; cwd: string; name: string }
        | null
    >(() => null),
    /** Pass-through del handler `request_hydrate_logs`. */
    hydrateLogs: vi.fn<(agentId: string) => void>(),
  };
}

function makeController(
  bridge: ReturnType<typeof makeBridge>,
): ScannerController {
  return new ScannerController({
    context: makeContext() as never,
    channel: makeOutputChannel() as never,
    bridge: bridge as unknown as DashboardBridge,
  });
}

// =====================================================================
// === Tests ===========================================================
// =====================================================================

describe('ScannerController.handleMessage — request_cancel', () => {
  beforeEach(() => {
    __resetVscode();
  });

  it('invoca bridge.cancel con el agentId recibido cuando cancelConfirm=false', () => {
    const bridge = makeBridge();
    const controller = makeController(bridge);
    controller.handleMessage({
      type: 'request_cancel',
      agentId: 'agent-abc',
    });
    expect(bridge.cancel).toHaveBeenCalledTimes(1);
    expect(bridge.cancel).toHaveBeenCalledWith('agent-abc');
    expect(__getWarningCalls()).toHaveLength(0);
  });

  it('cancelConfirm=true + user confirma → bridge.cancel invocado', async () => {
    __setConfig('claudeOrchestrator', 'cancelConfirm', true);
    __setWarningChoice('Cancel agent');
    const bridge = makeBridge();
    const controller = makeController(bridge);

    controller.handleMessage({ type: 'request_cancel', agentId: 'agent-abc' });
    // El handler es async (await del modal); flush el microtask queue
    // antes de assert. Sin esto el `cancel` no se llamó todavía.
    await new Promise((resolve) => setImmediate(resolve));

    expect(__getWarningCalls()).toHaveLength(1);
    expect(bridge.cancel).toHaveBeenCalledWith('agent-abc');
  });

  it('cancelConfirm=true + user mantiene corriendo → bridge.cancel NO se invoca', async () => {
    __setConfig('claudeOrchestrator', 'cancelConfirm', true);
    __setWarningChoice('Keep running');
    const bridge = makeBridge();
    const controller = makeController(bridge);

    controller.handleMessage({ type: 'request_cancel', agentId: 'agent-abc' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(__getWarningCalls()).toHaveLength(1);
    expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it('cancelConfirm=true + user dismiss (undefined) → bridge.cancel NO se invoca', async () => {
    // Dismiss = cierra el modal con ESC o click fuera. VS Code
    // resuelve con `undefined`. Mismo tratamiento que "Keep running":
    // no asumir consentimiento por silencio.
    __setConfig('claudeOrchestrator', 'cancelConfirm', true);
    __setWarningChoice(undefined);
    const bridge = makeBridge();
    const controller = makeController(bridge);

    controller.handleMessage({ type: 'request_cancel', agentId: 'agent-abc' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it('agentId vacío → bridge.cancel NO se invoca (guard defensivo)', () => {
    const bridge = makeBridge();
    const controller = makeController(bridge);
    controller.handleMessage({ type: 'request_cancel', agentId: '' });
    expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it('bridge.cancel retorna false (agente inexistente) → no-op silencioso', () => {
    // Defensivo: si el agente ya terminó antes de que el click
    // llegara, bridge.cancel devuelve false. No queremos que eso
    // tire ni dispare notification al user — el agente ya no está
    // corriendo, el efecto deseado se cumplió igual.
    const bridge = makeBridge();
    bridge.cancel.mockReturnValue(false);
    const controller = makeController(bridge);
    controller.handleMessage({ type: 'request_cancel', agentId: 'gone' });
    expect(bridge.cancel).toHaveBeenCalledWith('gone');
  });
});

// =====================================================================
// === Tests del handler request_open ==================================
// =====================================================================

describe('ScannerController.handleMessage — request_open', () => {
  beforeEach(() => {
    __resetVscode();
  });

  it('agentId desconocido → no-op silencioso (no abre URI, no muestra info)', () => {
    const bridge = makeBridge();
    // Default del mock: getResumeTarget retorna null.
    const controller = makeController(bridge);
    controller.handleMessage({ type: 'request_open', agentId: 'no-such-id' });
    expect(bridge.getResumeTarget).toHaveBeenCalledWith('no-such-id');
    expect(__getExecutedCommands()).toHaveLength(0);
    expect(__getInfoCalls()).toHaveLength(0);
  });

  it('agente sin sessionId → showInformationMessage + NO abre URI', async () => {
    const bridge = makeBridge();
    bridge.getResumeTarget.mockReturnValue({
      sessionId: undefined,
      cwd: '/repos/myproj',
      name: 'my-agent',
    });
    const controller = makeController(bridge);
    controller.handleMessage({ type: 'request_open', agentId: 'agent-a' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(__getInfoCalls()).toHaveLength(1);
    expect(__getInfoCalls()[0].message).toContain('my-agent');
    expect(__getExecutedCommands()).toHaveLength(0);
  });

  it('agente con sessionId + cwd dentro del workspace → invoca URI handler de claude-code', async () => {
    // Setup: workspace folder coincide con el cwd del agente para
    // que el guard `cwdInsideWorkspace` permita el modo chat.
    __setWorkspaceFolders(['/repos/myproj']);
    __setConfig('claudeOrchestrator', 'resumeIn', 'chat');
    const bridge = makeBridge();
    bridge.getResumeTarget.mockReturnValue({
      sessionId: 'aaaabbbb-1111-2222-3333-444455556666',
      cwd: '/repos/myproj',
      name: 'my-agent',
    });
    const controller = makeController(bridge);

    controller.handleMessage({ type: 'request_open', agentId: 'agent-a' });
    await new Promise((resolve) => setImmediate(resolve));

    const cmds = __getExecutedCommands();
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds[0].command).toBe('vscode.open');
    // El URI handler arma `vscode://anthropic.claude-code/open?session=<id>`.
    expect(String(cmds[0].args[0])).toContain(
      'aaaabbbb-1111-2222-3333-444455556666',
    );
  });

  it('agentId vacío → no-op + log', () => {
    const bridge = makeBridge();
    const controller = makeController(bridge);
    controller.handleMessage({ type: 'request_open', agentId: '' });
    expect(bridge.getResumeTarget).not.toHaveBeenCalled();
    expect(__getExecutedCommands()).toHaveLength(0);
  });
});

// =====================================================================
// === request_hydrate_logs NO se maneja en scanner-controller =========
// =====================================================================
//
// El detail panel (views/detail-panel.ts) intercepta este evento
// antes de delegar al scanner y llama bridge.hydrateLogs con su
// propio webview como target. Eso evita serializar el ringbuffer
// al sidebar. Verificamos que el scanner NO toque bridge.hydrateLogs
// cuando le llega ese tipo de mensaje (defensa contra reintroducir
// un pass-through que broadcast-earía a todos).

describe('ScannerController.handleMessage — request_hydrate_logs (no-op)', () => {
  beforeEach(() => {
    __resetVscode();
  });

  it('NO llama bridge.hydrateLogs (interceptado upstream por detail-panel)', () => {
    const bridge = makeBridge();
    const controller = makeController(bridge);
    controller.handleMessage({
      type: 'request_hydrate_logs',
      agentId: 'agent-abc',
    });
    expect(bridge.hydrateLogs).not.toHaveBeenCalled();
  });
});
