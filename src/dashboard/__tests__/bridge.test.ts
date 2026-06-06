/* ================================================================
 * bridge.test.ts — Tests del store del viewer (DashboardBridge).
 *
 * Re-enfoque a visualizador read-only: el bridge ya no spawnea ni
 * coordina agentes. Su fuente de datos es el ingester, que entra por
 * `ingest(event)`. Estos tests cubren:
 *   1. `isTerminalStatus` — SSoT de detección de estado terminal.
 *   2. ingest() — aplicar los 4 eventos `agent_*` al registry + post.
 *   3. webview / listeners — attach/detach, running count, completion.
 *   4. hydrate + persistencia — recovery de huérfanos, TTL, round-trip.
 *
 * `vscode` resuelve al stub manual en `src/__mocks__/vscode.ts` (alias
 * en vitest.config.ts). El fake ExtensionContext + OutputChannel viven
 * en `_fixtures.ts`. No hay FakeAgentRunner: el viewer no lanza agentes.
 * ================================================================ */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardBridge } from '../bridge';
import {
  LOG_RING_MAX,
  TERMINAL_STATUSES,
  isTerminalStatus,
  type AgentSnapshot,
  type AgentStatus,
  type DashboardEventToWebview,
  type LogEntry,
} from '../../shared/dashboard-protocol';
import { __resetVscode } from '../../__mocks__/vscode';
import { makeContext, makeOutputChannel } from './_fixtures';

const STATE_KEY = 'claudeOrchestrator.agents';

// =====================================================================
// === Helpers de test =================================================
// =====================================================================

/** Fake Webview con postMessage espiable. */
function makeWebview() {
  return {
    postMessage: vi.fn<(message: DashboardEventToWebview) => Thenable<boolean>>(
      () => Promise.resolve(true),
    ),
    asWebviewUri: vi.fn(),
    cspSource: 'self',
    html: '',
    options: {},
    onDidReceiveMessage: vi.fn(),
  };
}

/** Filtra los mensajes posteados al webview por tipo. */
function postedOf<T extends DashboardEventToWebview['type']>(
  webview: ReturnType<typeof makeWebview>,
  type: T,
): Extract<DashboardEventToWebview, { type: T }>[] {
  return webview.postMessage.mock.calls
    .map((c) => c[0])
    .filter((m): m is Extract<DashboardEventToWebview, { type: T }> => m.type === type);
}

/** Snapshot mínimo de un agente observado (status running por default). */
function makeSnapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: 'agent-1',
    name: 'audit-overrides',
    status: 'running',
    project: 'myproj',
    task: '',
    branch: 'main',
    batchId: 'session-abc',
    startedAtIso: '2026-06-05T10:00:00.000Z',
    elapsedMs: 0,
    tokensUsed: 0,
    contextUsedPct: 0,
    ...overrides,
  };
}

function created(agent: AgentSnapshot): DashboardEventToWebview {
  return { type: 'agent_created', agent };
}

function statusChanged(
  agentId: string,
  status: AgentStatus,
  metadata?: Partial<AgentSnapshot>,
): DashboardEventToWebview {
  return { type: 'agent_status_changed', agentId, status, metadata };
}

function log(agentId: string, entry: LogEntry): DashboardEventToWebview {
  return { type: 'agent_log', agentId, entry };
}

function completed(
  agentId: string,
  durationMs = 1000,
  status: 'done' | 'failed' | 'cancelled' = 'done',
): DashboardEventToWebview {
  return { type: 'agent_completed', agentId, result: { status, durationMs, tokensUsed: 0 } };
}

function textLog(text: string): LogEntry {
  return { ts: Date.now(), kind: 'text', text };
}

function makeBridge(ctx = makeContext()) {
  const channel = makeOutputChannel();
  const bridge = new DashboardBridge({
    context: ctx as never,
    channel: channel as never,
  });
  return { bridge, ctx, channel };
}

// =====================================================================
// === isTerminalStatus ================================================
// =====================================================================

describe('isTerminalStatus (SSoT for terminal status detection)', () => {
  it('cubre los 4 estados terminales del enum', () => {
    expect(TERMINAL_STATUSES).toEqual(['done', 'failed', 'cancelled', 'needs_review']);
  });

  it('done / failed / cancelled / needs_review → true', () => {
    expect(isTerminalStatus('done')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('needs_review')).toBe(true);
  });

  it('running / pending → false', () => {
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('pending')).toBe(false);
  });
});

// =====================================================================
// === ingest ==========================================================
// =====================================================================

describe('DashboardBridge — ingest', () => {
  beforeEach(() => __resetVscode());
  afterEach(() => vi.restoreAllMocks());

  it('agent_created inserta en el registry, postea el card y refleja running count', () => {
    const { bridge } = makeBridge();
    const webview = makeWebview();
    bridge.attachWebview(webview as never);

    let count = -1;
    bridge.onRunningCountChange((c) => (count = c));

    bridge.ingest(created(makeSnapshot()));

    const cards = postedOf(webview, 'agent_created');
    expect(cards).toHaveLength(1);
    expect(cards[0].agent.id).toBe('agent-1');
    expect(bridge.getRunningCount()).toBe(1);
    expect(count).toBe(1);
  });

  it('agent_created duplicado es idempotente (no re-inserta ni re-postea)', () => {
    const { bridge } = makeBridge();
    const webview = makeWebview();
    bridge.attachWebview(webview as never);

    bridge.ingest(created(makeSnapshot()));
    bridge.ingest(created(makeSnapshot({ name: 'otro-nombre' })));

    expect(postedOf(webview, 'agent_created')).toHaveLength(1);
    expect(bridge.getRunningCount()).toBe(1);
  });

  it('agent_status_changed actualiza snapshot + metadata y lo reemite', () => {
    const { bridge } = makeBridge();
    const webview = makeWebview();
    bridge.attachWebview(webview as never);

    bridge.ingest(created(makeSnapshot()));
    bridge.ingest(statusChanged('agent-1', 'running', { currentTool: 'Read', elapsedMs: 1200 }));

    const changes = postedOf(webview, 'agent_status_changed');
    expect(changes).toHaveLength(1);
    expect(changes[0].metadata?.currentTool).toBe('Read');
    // El snapshot vigente refleja la metadata: lo verificamos vía el
    // agent_list que recibe un webview nuevo al attachear.
    const fresh = makeWebview();
    bridge.attachWebview(fresh as never);
    const snap = postedOf(fresh, 'agent_list')[0].agents[0];
    expect(snap.currentTool).toBe('Read');
    expect(snap.elapsedMs).toBe(1200);
  });

  it('invariante: una vez terminal, un status_changed running tardío NO degrada', () => {
    const { bridge } = makeBridge();
    bridge.ingest(created(makeSnapshot()));
    bridge.ingest(completed('agent-1'));
    // Evento tardío del SDK (race): no debe volver a running.
    bridge.ingest(statusChanged('agent-1', 'running', { currentTool: 'Bash' }));

    const fresh = makeWebview();
    bridge.attachWebview(fresh as never);
    const snap = postedOf(fresh, 'agent_list')[0].agents[0];
    expect(snap.status).toBe('done');
    // La metadata útil sí se mergea aunque el status no cambie.
    expect(snap.currentTool).toBe('Bash');
  });

  it('agent_log appendea al ringbuffer y lo reemite', () => {
    const { bridge } = makeBridge();
    const webview = makeWebview();
    bridge.attachWebview(webview as never);

    bridge.ingest(created(makeSnapshot()));
    bridge.ingest(log('agent-1', textLog('hola')));

    const logs = postedOf(webview, 'agent_log');
    expect(logs).toHaveLength(1);
    expect(logs[0].entry).toMatchObject({ kind: 'text', text: 'hola' });
  });

  it('el ringbuffer está acotado a LOG_RING_MAX (FIFO)', () => {
    const { bridge } = makeBridge();
    bridge.ingest(created(makeSnapshot()));
    for (let i = 0; i < LOG_RING_MAX + 25; i++) {
      bridge.ingest(log('agent-1', textLog(`line ${i}`)));
    }
    const target = makeWebview();
    bridge.hydrateLogs('agent-1', target as never);
    const history = postedOf(target, 'agent_log_history')[0];
    expect(history.entries).toHaveLength(LOG_RING_MAX);
    // El más viejo cayó; el último entry es el más reciente.
    expect((history.entries.at(-1) as { text: string }).text).toBe(
      `line ${LOG_RING_MAX + 24}`,
    );
  });

  it('agent_completed fija el estado terminal, reemite y baja el running count', () => {
    const { bridge } = makeBridge();
    const webview = makeWebview();
    bridge.attachWebview(webview as never);

    const counts: number[] = [];
    bridge.onRunningCountChange((c) => counts.push(c));

    bridge.ingest(created(makeSnapshot()));
    bridge.ingest(completed('agent-1', 4200));

    const done = postedOf(webview, 'agent_completed');
    expect(done).toHaveLength(1);
    expect(done[0].result).toMatchObject({ status: 'done', durationMs: 4200 });
    expect(bridge.getRunningCount()).toBe(0);
    // counts: [0 (suscripción), 1 (created), 0 (completed)].
    expect(counts.at(-1)).toBe(0);
  });

  it('secuencia completa created→status→log→status(done)→completed', () => {
    const { bridge } = makeBridge();
    const webview = makeWebview();
    bridge.attachWebview(webview as never);

    bridge.ingest(created(makeSnapshot()));
    bridge.ingest(statusChanged('agent-1', 'running', { currentTool: 'Glob' }));
    bridge.ingest(log('agent-1', textLog('found 3 files')));
    bridge.ingest(
      statusChanged('agent-1', 'done', { completedAtIso: '2026-06-05T10:05:00.000Z', durationMs: 300_000 }),
    );
    bridge.ingest(completed('agent-1', 300_000));

    expect(postedOf(webview, 'agent_created')).toHaveLength(1);
    expect(postedOf(webview, 'agent_log')).toHaveLength(1);
    expect(postedOf(webview, 'agent_completed')).toHaveLength(1);

    const fresh = makeWebview();
    bridge.attachWebview(fresh as never);
    const snap = postedOf(fresh, 'agent_list')[0].agents[0];
    expect(snap.status).toBe('done');
    expect(snap.completedAtIso).toBe('2026-06-05T10:05:00.000Z');
    expect(snap.durationMs).toBe(300_000);
  });

  it('guards: status_changed / log / completed de un agentId desconocido no tiran', () => {
    const { bridge } = makeBridge();
    const webview = makeWebview();
    bridge.attachWebview(webview as never);

    expect(() => {
      bridge.ingest(statusChanged('ghost', 'running'));
      bridge.ingest(log('ghost', textLog('x')));
      bridge.ingest(completed('ghost'));
    }).not.toThrow();
    // Los eventos igual se reemiten (passthrough), pero no hay agente
    // en el registry → no completion ni count change.
    expect(bridge.getRunningCount()).toBe(0);
  });

  it('default: un evento ajeno al ciclo agent_* se descarta (no se reemite ni toca el registry)', () => {
    const { bridge } = makeBridge();
    const webview = makeWebview();
    bridge.attachWebview(webview as never);

    // El ingester solo produce agent_*; un tipo inesperado es bug de
    // cableado → se loguea y descarta, NO se reenvía sin trackear.
    bridge.ingest({ type: 'projects_from_disk', projects: [], scannedAtIso: 'now' });
    expect(postedOf(webview, 'projects_from_disk')).toHaveLength(0);
    expect(bridge.getRunningCount()).toBe(0);
  });
});

// =====================================================================
// === webview / listeners =============================================
// =====================================================================

describe('DashboardBridge — webview y listeners', () => {
  beforeEach(() => __resetVscode());
  afterEach(() => vi.restoreAllMocks());

  it('attachWebview emite agent_list con el snapshot vigente', () => {
    const { bridge } = makeBridge();
    bridge.ingest(created(makeSnapshot()));

    const webview = makeWebview();
    bridge.attachWebview(webview as never);
    const list = postedOf(webview, 'agent_list')[0];
    expect(list.agents).toHaveLength(1);
    expect(list.agents[0].id).toBe('agent-1');
  });

  it('attachWebview hidrata SOLO al webview nuevo, no broadcast', () => {
    const { bridge } = makeBridge();
    const first = makeWebview();
    bridge.attachWebview(first as never);
    bridge.ingest(created(makeSnapshot()));
    first.postMessage.mockClear();

    const second = makeWebview();
    bridge.attachWebview(second as never);

    expect(postedOf(second, 'agent_list')).toHaveLength(1);
    // El primer webview NO recibe un agent_list nuevo (le vaciaría logs).
    expect(postedOf(first, 'agent_list')).toHaveLength(0);
  });

  it('onAttach: callbacks registrados se ejecutan al attach', () => {
    const { bridge } = makeBridge();
    const cb = vi.fn();
    bridge.onAttach(cb);
    bridge.attachWebview(makeWebview() as never);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('onAttach: un callback que tira NO rompe attach ni los siguientes', () => {
    const { bridge } = makeBridge();
    const good = vi.fn();
    bridge.onAttach(() => {
      throw new Error('boom');
    });
    bridge.onAttach(good);
    const webview = makeWebview();
    expect(() => bridge.attachWebview(webview as never)).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(postedOf(webview, 'agent_list')).toHaveLength(1);
  });

  it('detachWebview deja de recibir eventos', () => {
    const { bridge } = makeBridge();
    const webview = makeWebview();
    bridge.attachWebview(webview as never);
    bridge.detachWebview(webview as never);
    webview.postMessage.mockClear();

    bridge.ingest(created(makeSnapshot()));
    expect(postedOf(webview, 'agent_created')).toHaveLength(0);
  });

  it('onRunningCountChange emite el count actual al suscribirse y tras cada delta', () => {
    const { bridge } = makeBridge();
    const counts: number[] = [];
    bridge.onRunningCountChange((c) => counts.push(c));
    expect(counts).toEqual([0]);

    bridge.ingest(created(makeSnapshot({ id: 'a' })));
    bridge.ingest(created(makeSnapshot({ id: 'b' })));
    bridge.ingest(completed('a'));

    expect(counts).toEqual([0, 1, 2, 1]);
  });

  it('onAgentCompleted dispara una vez por agente cuando llega a terminal', () => {
    const { bridge } = makeBridge();
    const events: string[] = [];
    bridge.onAgentCompleted((e) => events.push(`${e.agentId}:${e.status}`));

    bridge.ingest(created(makeSnapshot({ id: 'a' })));
    bridge.ingest(completed('a', 100, 'done'));

    expect(events).toEqual(['a:done']);
  });

  it('onAgentCompleted: status failed / cancelled también dispara', () => {
    const { bridge } = makeBridge();
    const events: string[] = [];
    bridge.onAgentCompleted((e) => events.push(e.status));

    bridge.ingest(created(makeSnapshot({ id: 'a' })));
    bridge.ingest(completed('a', 1, 'failed'));
    bridge.ingest(created(makeSnapshot({ id: 'b' })));
    bridge.ingest(completed('b', 1, 'cancelled'));

    expect(events).toEqual(['failed', 'cancelled']);
  });

  it('onAgentCompleted: un listener que tira no rompe al siguiente', () => {
    const { bridge } = makeBridge();
    const good = vi.fn();
    bridge.onAgentCompleted(() => {
      throw new Error('boom');
    });
    bridge.onAgentCompleted(good);

    bridge.ingest(created(makeSnapshot({ id: 'a' })));
    expect(() => bridge.ingest(completed('a'))).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('onAgentCompleted: unsubscribe deja de recibir notifs', () => {
    const { bridge } = makeBridge();
    const cb = vi.fn();
    const off = bridge.onAgentCompleted(cb);
    off();
    bridge.ingest(created(makeSnapshot({ id: 'a' })));
    bridge.ingest(completed('a'));
    expect(cb).not.toHaveBeenCalled();
  });

  it('getResumeTarget retorna sessionId + name; null si no existe', () => {
    const { bridge } = makeBridge();
    bridge.ingest(created(makeSnapshot({ id: 'a', sessionId: 'sess-9', name: 'mig' })));
    expect(bridge.getResumeTarget('a')).toEqual({
      sessionId: 'sess-9',
      cwd: '',
      name: 'mig',
    });
    expect(bridge.getResumeTarget('nope')).toBe(null);
  });

  it('cancel es no-op en el viewer (devuelve false)', () => {
    const { bridge } = makeBridge();
    bridge.ingest(created(makeSnapshot({ id: 'a' })));
    expect(bridge.cancel('a')).toBe(false);
    expect(bridge.cancel('nope')).toBe(false);
  });

  it('hydrateLogs emite agent_log_history al target con todos los entries', () => {
    const { bridge } = makeBridge();
    bridge.ingest(created(makeSnapshot({ id: 'a' })));
    bridge.ingest(log('a', textLog('uno')));
    bridge.ingest(log('a', textLog('dos')));

    const target = makeWebview();
    bridge.hydrateLogs('a', target as never);
    const history = postedOf(target, 'agent_log_history')[0];
    expect(history.agentId).toBe('a');
    expect(history.entries).toHaveLength(2);
  });

  it('hydrateLogs de un agente inexistente emite entries vacíos (no tira)', () => {
    const { bridge } = makeBridge();
    const target = makeWebview();
    expect(() => bridge.hydrateLogs('ghost', target as never)).not.toThrow();
    expect(postedOf(target, 'agent_log_history')[0].entries).toEqual([]);
  });
});

// =====================================================================
// === hydrate / persistencia ==========================================
// =====================================================================

describe('DashboardBridge — hydrate y persistencia', () => {
  beforeEach(() => __resetVscode());
  afterEach(() => vi.restoreAllMocks());

  it('hydrate con globalState vacío deja el registry vacío', async () => {
    const { bridge } = makeBridge();
    await bridge.hydrate();
    const webview = makeWebview();
    bridge.attachWebview(webview as never);
    expect(postedOf(webview, 'agent_list')[0].agents).toEqual([]);
  });

  it('hydrate marca agentes running huérfanos como failed / ide_restart', async () => {
    const ctx = makeContext();
    ctx.globalState.update(STATE_KEY, [
      {
        snapshot: makeSnapshot({ id: 'orphan', status: 'running' }),
        cwd: '/x',
        prompt: 'p',
        log: [],
      },
    ]);
    const { bridge } = makeBridge(ctx);
    await bridge.hydrate();

    const webview = makeWebview();
    bridge.attachWebview(webview as never);
    const snap = postedOf(webview, 'agent_list')[0].agents[0];
    expect(snap.status).toBe('failed');
    expect(snap.reason).toBe('ide_restart');
    expect(snap.completedAtIso).toBeTruthy();
  });

  it('hydrate evicta items completados hace más de 30 días', async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const ctx = makeContext();
    ctx.globalState.update(STATE_KEY, [
      {
        snapshot: makeSnapshot({ id: 'stale', status: 'done', completedAtIso: old }),
        cwd: '',
        prompt: '',
        log: [],
      },
    ]);
    const { bridge } = makeBridge(ctx);
    await bridge.hydrate();

    const webview = makeWebview();
    bridge.attachWebview(webview as never);
    expect(postedOf(webview, 'agent_list')[0].agents).toEqual([]);
  });

  it('hydrate con completedAtIso malformado NO evicta (guard defensivo)', async () => {
    const ctx = makeContext();
    ctx.globalState.update(STATE_KEY, [
      {
        snapshot: makeSnapshot({ id: 'weird', status: 'done', completedAtIso: 'not-a-date' }),
        cwd: '',
        prompt: '',
        log: [],
      },
    ]);
    const { bridge } = makeBridge(ctx);
    await bridge.hydrate();

    const webview = makeWebview();
    bridge.attachWebview(webview as never);
    expect(postedOf(webview, 'agent_list')[0].agents).toHaveLength(1);
  });

  it('round-trip: ingest → dispose (flush) → nuevo bridge hydrata el mismo agente', async () => {
    const ctx = makeContext();
    const { bridge: bridgeA } = makeBridge(ctx);
    bridgeA.ingest(created(makeSnapshot({ id: 'persisted', status: 'done', completedAtIso: '2026-06-05T10:00:00.000Z' })));
    await bridgeA.dispose();

    const { bridge: bridgeB } = makeBridge(ctx);
    await bridgeB.hydrate();
    const webview = makeWebview();
    bridgeB.attachWebview(webview as never);
    const agents = postedOf(webview, 'agent_list')[0].agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('persisted');
  });
});

// =====================================================================
// === Resurrección de huérfanos (liveness reconciliation) =============
// =====================================================================

describe('DashboardBridge — resurrección de huérfanos', () => {
  beforeEach(() => __resetVscode());
  afterEach(() => vi.restoreAllMocks());

  /** Hidrata un bridge con un único agente huérfano (failed/ide_restart). */
  async function withOrphan(id = 'orphan') {
    const ctx = makeContext();
    ctx.globalState.update(STATE_KEY, [
      { snapshot: makeSnapshot({ id, status: 'running' }), cwd: '/x', prompt: 'p', log: [] },
    ]);
    const { bridge } = makeBridge(ctx);
    await bridge.hydrate();
    return { bridge };
  }

  it('un status_changed running sobre un huérfano lo resucita y reconcilia', async () => {
    const { bridge } = await withOrphan();
    bridge.ingest(statusChanged('orphan', 'running', { currentTool: 'Read' }));

    const fresh = makeWebview();
    bridge.attachWebview(fresh as never);
    const snap = postedOf(fresh, 'agent_list')[0].agents[0];
    expect(snap.status).toBe('running');
    expect(snap.reason).toBeUndefined();
    expect(snap.completedAtIso).toBeUndefined();
    expect(snap.currentTool).toBe('Read');
    // El evento vivo selló actividad reciente → no debe quedar "idle".
    expect(snap.lastActivityIso).toBeTruthy();
    expect(bridge.getRunningCount()).toBe(1);
  });

  it('resucitar refresca el running count (failed→running)', async () => {
    const { bridge } = await withOrphan();
    const counts: number[] = [];
    bridge.onRunningCountChange((c) => counts.push(c));
    expect(counts).toEqual([0]); // huérfano failed no cuenta
    bridge.ingest(statusChanged('orphan', 'running'));
    expect(counts.at(-1)).toBe(1);
  });

  it('un agent_created sobre un huérfano NO duplica el card: reemite running, no created', async () => {
    const { bridge } = await withOrphan();
    const live = makeWebview();
    bridge.attachWebview(live as never);

    bridge.ingest(created(makeSnapshot({ id: 'orphan', status: 'running' })));

    // No re-emite agent_created (duplicaría el card del lado webview).
    expect(postedOf(live, 'agent_created')).toHaveLength(0);
    expect(postedOf(live, 'agent_status_changed').some((e) => e.status === 'running')).toBe(true);

    const fresh = makeWebview();
    bridge.attachWebview(fresh as never);
    const agents = postedOf(fresh, 'agent_list')[0].agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].status).toBe('running');
    expect(agents[0].lastActivityIso).toBeTruthy();
    expect(bridge.getRunningCount()).toBe(1);
  });

  it('un agent_completed real tras restart override-a el ide_restart', async () => {
    const { bridge } = await withOrphan();
    bridge.ingest(completed('orphan', 4200, 'done'));

    const fresh = makeWebview();
    bridge.attachWebview(fresh as never);
    const snap = postedOf(fresh, 'agent_list')[0].agents[0];
    expect(snap.status).toBe('done');
    expect(snap.reason).toBeUndefined(); // ide_restart limpiado
    expect(snap.durationMs).toBe(4200);
    expect(bridge.getRunningCount()).toBe(0);
  });

  it('un failed real (reason ≠ ide_restart) NO se resucita con un evento tardío', () => {
    const { bridge } = makeBridge();
    bridge.ingest(created(makeSnapshot({ id: 'a' })));
    bridge.ingest({
      type: 'agent_completed',
      agentId: 'a',
      result: { status: 'failed', durationMs: 1, tokensUsed: 0, reason: 'oom' },
    });
    // Evento vivo tardío: NO debe revertir un failed legítimo.
    bridge.ingest(statusChanged('a', 'running', { currentTool: 'Bash' }));

    const fresh = makeWebview();
    bridge.attachWebview(fresh as never);
    const snap = postedOf(fresh, 'agent_list')[0].agents[0];
    expect(snap.status).toBe('failed');
    expect(snap.reason).toBe('oom');
  });
});
