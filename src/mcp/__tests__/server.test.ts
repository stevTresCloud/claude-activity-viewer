/* ================================================================
 * server.test.ts — Tests del handler de tools del OrchestratorMcpServer.
 *
 * Los handlers viven como callbacks privados dentro de
 * `registerTool` calls, así que para testearlos sin levantar
 * McpServer + transport HTTP real exponemos métodos públicos
 * `cancelAgent` (etc.) con la lógica pura y dejamos `register*`
 * como wiring trivial al SDK.
 *
 * Foco de esta suite:
 *   - cancel_agent · happy path: bridge.cancel retorna true
 *   - cancel_agent · false-not-error: bridge.cancel retorna false
 *     (estado válido, no error operacional)
 *
 * Bridge y OutputChannel se fakean con tipos mínimos. El bridge
 * real implementa Listeners/registry/persistencia — para este
 * test solo importa el método `cancel(id) → boolean`.
 * ================================================================ */

import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { DashboardBridge } from '../../dashboard/bridge';
import { OrchestratorMcpServer } from '../server';

function makeChannel(): vscode.OutputChannel {
  return {
    name: 'test',
    append: vi.fn(),
    appendLine: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    replace: vi.fn(),
  } as unknown as vscode.OutputChannel;
}

function makeServer(cancel: (id: string) => boolean) {
  const bridge = {
    cancel: vi.fn(cancel),
  } as unknown as DashboardBridge;
  const server = new OrchestratorMcpServer({
    channel: makeChannel(),
    serverInfo: { name: 'test', version: '0.0.0' },
    bridge,
    allowedHosts: ['127.0.0.1:0'],
  });
  return { server, bridge: bridge as unknown as { cancel: ReturnType<typeof vi.fn> } };
}

describe('OrchestratorMcpServer · cancelAgent', () => {
  it('devuelve { cancelled: true, agent_id } cuando el bridge cancela', () => {
    const { server, bridge } = makeServer(() => true);
    const payload = server.cancelAgent('abc-123');
    expect(bridge.cancel).toHaveBeenCalledWith('abc-123');
    expect(payload).toEqual({ cancelled: true, agent_id: 'abc-123' });
  });

  it('devuelve { cancelled: false, agent_id } cuando el agente no estaba vivo', () => {
    // false NO es error: el agente puede haber terminado, nunca
    // existido, o vivir en otro registry. Estado válido.
    const { server, bridge } = makeServer(() => false);
    const payload = server.cancelAgent('missing');
    expect(bridge.cancel).toHaveBeenCalledWith('missing');
    expect(payload).toEqual({ cancelled: false, agent_id: 'missing' });
  });

  it('propaga la excepción del bridge — el handler MCP la traduce a isError', () => {
    // El método público re-lanza para que el handler MCP arme el
    // payload { isError:true, error, agent_id }. La rama no se
    // ejerce en producción (bridge.cancel no tira), pero el contrato
    // documentado lo exige.
    const { server } = makeServer(() => {
      throw new Error('boom');
    });
    expect(() => server.cancelAgent('agent-x')).toThrow('boom');
  });
});
