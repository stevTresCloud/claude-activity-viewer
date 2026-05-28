/* ================================================================
 * http-transport.test.ts — Tests del wrapper HTTP del MCP server.
 *
 * Foco principal: subtarea B del ticket #0 v0.2 — los hooks de
 * keep-alive aplicados a cada request antes de delegar al MCP. Sin
 * ellos, el cliente puede ver "transport dropped" en long-polls de
 * `wait_for_agents` por idle timeout del socket Node.
 *
 * Estrategia: NO levantamos un server HTTP real (ESM impide spyOn de
 * `http.createServer`). Llamamos directo al método público
 * `handleRequest(req, res)` con fakes mínimos de IncomingMessage +
 * ServerResponse y verificamos los efectos observables.
 * ================================================================ */

import { describe, expect, it, vi } from 'vitest';
import type * as http from 'node:http';
import type * as vscode from 'vscode';

import { OrchestratorHttpServer } from '../http-transport';
import type { DashboardBridge } from '../../dashboard/bridge';

// === Fakes mínimos del shape Node http que el wrapper consume ===

interface FakeSocket {
  setKeepAlive: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
}

interface FakeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  socket: FakeSocket;
  on: (event: string, cb: () => void) => void;
}

interface FakeResponse {
  setHeader: ReturnType<typeof vi.fn>;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  headersSent: boolean;
}

function makeSocket(): FakeSocket {
  return {
    setKeepAlive: vi.fn(),
    setTimeout: vi.fn(),
  };
}

function makeRequest(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    url: '/mcp',
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    socket: makeSocket(),
    on: vi.fn(),
    ...overrides,
  };
}

function makeResponse(): FakeResponse {
  return {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false,
  };
}

function makeServer(bearer = 'test-token'): OrchestratorHttpServer {
  const channel: vscode.OutputChannel = {
    appendLine: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    name: 'test',
    replace: vi.fn(),
  } as unknown as vscode.OutputChannel;
  // El bridge nunca se invoca en estos tests (handleRequest aplica
  // hooks y delega al MCP, pero el MCP nunca llega a correr porque
  // los tests fallan en 404/401 o nunca esperamos la promise async).
  const bridge = {} as DashboardBridge;
  return new OrchestratorHttpServer({
    channel,
    bridge,
    serverInfo: { name: 'test', version: '0.0.0' },
    bearerToken: bearer,
  });
}

function invoke(
  server: OrchestratorHttpServer,
  req: FakeRequest,
  res: FakeResponse,
): void {
  server.handleRequest(
    req as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse,
  );
}

// === Tests ===

describe('OrchestratorHttpServer — keep-alive hooks (subtarea B ticket #0 v0.2)', () => {
  it('aplica Connection: keep-alive header antes de delegar al MCP', () => {
    const server = makeServer();
    const req = makeRequest();
    const res = makeResponse();
    invoke(server, req, res);
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
  });

  it('aplica Keep-Alive header con timeout amplio para long-polls', () => {
    const server = makeServer();
    const req = makeRequest();
    const res = makeResponse();
    invoke(server, req, res);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Keep-Alive',
      expect.stringContaining('timeout=1200'),
    );
  });

  it('llama setKeepAlive(true, 15s) sobre el socket TCP', () => {
    const server = makeServer();
    const req = makeRequest();
    const res = makeResponse();
    invoke(server, req, res);
    expect(req.socket.setKeepAlive).toHaveBeenCalledWith(true, 15_000);
  });

  it('desactiva idle timeout del socket con setTimeout(0)', () => {
    const server = makeServer();
    const req = makeRequest();
    const res = makeResponse();
    invoke(server, req, res);
    expect(req.socket.setTimeout).toHaveBeenCalledWith(0);
  });

  it('NO aplica los hooks si el path no es /mcp (404 corto-circuito)', () => {
    const server = makeServer();
    const req = makeRequest({ url: '/favicon.ico' });
    const res = makeResponse();
    invoke(server, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything());
    // 404 devuelto sin tocar el socket — el browser probing por
    // /favicon.ico no merece un socket TCP-KA tuneado.
    expect(req.socket.setKeepAlive).not.toHaveBeenCalled();
  });

  it('NO aplica los hooks si la auth bearer falla (401 corto-circuito)', () => {
    const server = makeServer();
    const req = makeRequest({ headers: { authorization: 'Bearer wrong' } });
    const res = makeResponse();
    invoke(server, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.anything());
    // El socket no debe quedar tuneado para un caller sin auth — sería
    // recurso gratis para un atacante local que sabe del puerto.
    expect(req.socket.setKeepAlive).not.toHaveBeenCalled();
  });
});
