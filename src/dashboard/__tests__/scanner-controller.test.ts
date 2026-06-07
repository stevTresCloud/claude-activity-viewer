/* ================================================================
 * scanner-controller.test.ts — Tests del despachador webview→ext.
 *
 * Cubre el switch de `handleMessage` del ScannerController. El
 * viewer es read-only, así que el switch solo enruta `request_rescan`
 * y `request_resume_session`; `request_hydrate_logs` lo intercepta
 * detail-panel.ts upstream y acá verificamos que NO lo toque.
 *
 * Decisiones de testing:
 *   - NO llamamos `start()` del controller en estos tests: arrancar
 *     el scanner dispara `scanProjects` + `scanSessions` sobre el
 *     filesystem real (lectura de `~/.claude/projects/`). Lo que nos
 *     interesa es el switch de `handleMessage`, no el lifecycle.
 *   - `bridge` se reemplaza por un `FakeBridge` mínimo. Mantener la
 *     fachada chica evita arrastrar el grafo entero del bridge real.
 * ================================================================ */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScannerController } from '../scanner-controller';
import { __resetVscode } from '../../__mocks__/vscode';
import type { DashboardBridge } from '../bridge';
import { makeContext, makeOutputChannel } from './_fixtures';

// =====================================================================
// === Helpers de test =================================================
// =====================================================================

/**
 * FakeBridge — implementación mínima de la fachada que el
 * scanner-controller consume. `emit` y `onAttach` son stubs;
 * `hydrateLogs` es espiable para el test del no-op.
 */
function makeBridge() {
  return {
    emit: vi.fn(),
    onAttach: vi.fn<(cb: () => void) => () => void>(() => () => {}),
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
