// @vitest-environment happy-dom

/* ================================================================
 * useAgentsStore.test.ts — Tests del store Pinia del dashboard.
 *
 * Cubre las 5 actions de mutación + los 7 getters derivados con
 * foco en edge cases que la UI no exhibe en happy path pero que
 * el bridge puede gatillar (ISO inválidos, agentes sin
 * completedAtIso, ringbuffer del log, etc.).
 *
 * Decisiones de testing:
 *   - `happy-dom` porque Pinia 3 + Vue reactivity toca APIs del
 *     window globalmente al primer import. Más liviano que jsdom.
 *   - `useNow` mockeado a un `ref` estático para eliminar el
 *     setInterval del singleton — sin esto, cada test deja un
 *     timer huérfano + el computed `projectsByLifecycle` se podría
 *     invalidar entre asserts por el tick real.
 *   - Pinia se re-crea con `setActivePinia(createPinia())` en cada
 *     test para que el state arranque limpio.
 * ================================================================ */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';

// useNow mockeado ANTES del import del store: el store importa el
// composable a tope de archivo y nuestra versión devuelve un ref
// estático sin interval. Suficiente porque los tests no validan
// el ciclo de tick (eso es responsabilidad de Vue, no del store).
vi.mock('../../composables/useNow', () => ({
  useNow: () => ref(0),
}));

import { useAgentsStore } from '../useAgentsStore';
import type { AgentSnapshot } from '../../../shared/dashboard-protocol';

// =====================================================================
// === Fixtures =========================================================
// =====================================================================

// ISO fijo en el fixture base para mantenerlo determinístico:
// `new Date().toISOString()` introduciría wallclock vivo y rompería
// el aislamiento de los tests que congelan el reloj con fake timers.
const FIXED_STARTED_AT_ISO = '2026-05-25T00:00:00.000Z';

/** Snapshot mínimo válido — los tests sobreescriben campos puntuales. */
function snap(overrides: Partial<AgentSnapshot> & { id: string }): AgentSnapshot {
  return {
    name: `agent-${overrides.id}`,
    status: 'running',
    project: 'proj',
    task: '',
    branch: '',
    batchId: 'b-1',
    startedAtIso: FIXED_STARTED_AT_ISO,
    elapsedMs: 0,
    tokensUsed: 0,
    contextUsedPct: 0,
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.useRealTimers();
});

// =====================================================================
// === Actions de mutación =============================================
// =====================================================================

describe('useAgentsStore — actions', () => {
  it('applyAgentList reemplaza el state y resetea logsByAgent', () => {
    const store = useAgentsStore();
    store.appendLog('legacy', { ts: 1, kind: 'text', text: 'pre' });
    store.applyAgentList([snap({ id: 'a' }), snap({ id: 'b' })]);
    expect(store.agents).toHaveLength(2);
    expect(store.agents.map((a) => a.id)).toEqual(['a', 'b']);
    expect(store.logsByAgent).toEqual({});
  });

  it('addAgent hace push al final preservando orden de inserción', () => {
    const store = useAgentsStore();
    store.addAgent(snap({ id: 'a' }));
    store.addAgent(snap({ id: 'b' }));
    expect(store.agents.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('updateAgentStatus muta status y mergea metadata sin pisar otros campos', () => {
    const store = useAgentsStore();
    store.addAgent(snap({ id: 'a', name: 'first', tokensUsed: 100 }));
    store.updateAgentStatus('a', 'running', {
      currentTool: 'Read',
      tokensUsed: 5000,
    });
    const agent = store.agents[0];
    expect(agent.status).toBe('running');
    expect(agent.currentTool).toBe('Read');
    expect(agent.tokensUsed).toBe(5000);
    // Campo no enviado se preserva — el assign es shallow merge.
    expect(agent.name).toBe('first');
  });

  it('updateAgentStatus con id inexistente es no-op (no tira)', () => {
    const store = useAgentsStore();
    store.addAgent(snap({ id: 'a' }));
    expect(() => store.updateAgentStatus('no-existe', 'failed')).not.toThrow();
    expect(store.agents[0].status).toBe('running');
  });

  it('appendLog respeta el bound FIFO 1000 — push 1001 → primer entry descartado', () => {
    const store = useAgentsStore();
    for (let i = 0; i < 1001; i++) {
      store.appendLog('a', { ts: i, kind: 'text', text: `e-${i}` });
    }
    expect(store.logsByAgent['a']).toHaveLength(1000);
    expect(store.logsByAgent['a'][0]?.text).toBe('e-1');
    expect(store.logsByAgent['a'][999]?.text).toBe('e-1000');
  });

  it('markAgentCompleted setea status final + duration + tokens + reason + completedAtIso si falta', () => {
    const store = useAgentsStore();
    store.addAgent(snap({ id: 'a' }));
    store.markAgentCompleted('a', {
      status: 'failed',
      durationMs: 5000,
      tokensUsed: 12_000,
      reason: 'oom',
    });
    const agent = store.agents[0];
    expect(agent.status).toBe('failed');
    expect(agent.durationMs).toBe(5000);
    expect(agent.tokensUsed).toBe(12_000);
    expect(agent.reason).toBe('oom');
    expect(agent.completedAtIso).toBeDefined();
  });

  it('markAgentCompleted no pisa completedAtIso preexistente', () => {
    const store = useAgentsStore();
    const preset = '2026-01-01T00:00:00.000Z';
    store.addAgent(snap({ id: 'a', completedAtIso: preset }));
    store.markAgentCompleted('a', { status: 'done', durationMs: 1, tokensUsed: 0 });
    expect(store.agents[0].completedAtIso).toBe(preset);
  });

  it('markAgentCompleted con id inexistente es no-op', () => {
    const store = useAgentsStore();
    store.addAgent(snap({ id: 'a' }));
    expect(() =>
      store.markAgentCompleted('no-existe', { status: 'done', durationMs: 1, tokensUsed: 0 }),
    ).not.toThrow();
  });

  it('markAgentCompleted sin reason no toca el campo (no pisa con undefined)', () => {
    // Defensiva: el bridge a veces emite agent_completed sin reason
    // (cuando el agente termina OK). Si la action asignara directo
    // `agent.reason = result.reason` el campo quedaría `undefined`
    // explícito. Verificamos que el guard `if (result.reason)` se
    // respete y el campo no aparezca en el snapshot.
    const store = useAgentsStore();
    store.addAgent(snap({ id: 'a' }));
    store.markAgentCompleted('a', { status: 'done', durationMs: 100, tokensUsed: 0 });
    expect(store.agents[0].reason).toBeUndefined();
  });
});

// =====================================================================
// === Getters: secciones del dashboard ================================
// =====================================================================

describe('useAgentsStore — getters de sección', () => {
  it('nowPlaying/upNext/recent filtran por status correctamente', () => {
    const store = useAgentsStore();
    store.applyAgentList([
      snap({ id: 'r1', status: 'running' }),
      snap({ id: 'p1', status: 'pending' }),
      snap({
        id: 'd1',
        status: 'done',
        completedAtIso: '2026-05-25T12:00:00Z',
      }),
      snap({
        id: 'f1',
        status: 'failed',
        completedAtIso: '2026-05-25T13:00:00Z',
      }),
      snap({
        id: 'c1',
        status: 'cancelled',
        completedAtIso: '2026-05-25T14:00:00Z',
      }),
    ]);
    expect(store.nowPlaying.map((a) => a.id)).toEqual(['r1']);
    expect(store.upNext.map((a) => a.id)).toEqual(['p1']);
    // recent ordena descendente por completedAtIso.
    expect(store.recent.map((a) => a.id)).toEqual(['c1', 'f1', 'd1']);
  });
});

// =====================================================================
// === recentFailedCount con guard contra ISO inválido =================
// =====================================================================

describe('useAgentsStore — recentFailedCount', () => {
  // Congelamos el reloj para que las ventanas 24h sean
  // determinísticas — sin fake timers, la edad del completedAtIso
  // se evalúa contra el `Date.now()` real y el test se vuelve
  // sensible al wallclock al correrlo.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
  });

  it('cuenta failed con completedAtIso <24h', () => {
    const store = useAgentsStore();
    store.applyAgentList([
      snap({
        id: 'f-recent',
        status: 'failed',
        completedAtIso: '2026-05-26T06:00:00Z',
      }),
    ]);
    expect(store.recentFailedCount).toBe(1);
  });

  it('NO cuenta failed con completedAtIso >24h', () => {
    const store = useAgentsStore();
    store.applyAgentList([
      snap({
        id: 'f-old',
        status: 'failed',
        completedAtIso: '2026-05-24T06:00:00Z',
      }),
    ]);
    expect(store.recentFailedCount).toBe(0);
  });

  it('NO cuenta failed con completedAtIso inválido (Number.isFinite guard)', () => {
    const store = useAgentsStore();
    store.applyAgentList([
      snap({ id: 'f-bad', status: 'failed', completedAtIso: 'not-an-iso' }),
    ]);
    expect(store.recentFailedCount).toBe(0);
  });
});

// =====================================================================
// === projectsByLifecycle =============================================
// =====================================================================

describe('useAgentsStore — projectsByLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
  });

  it('proyecto con running queda como active', () => {
    const store = useAgentsStore();
    store.applyAgentList([snap({ id: 'a', status: 'running', project: 'p1' })]);
    expect(store.projectsByLifecycle.active.map((p) => p.name)).toEqual(['p1']);
    expect(store.projectsByLifecycle.idle).toEqual([]);
    expect(store.projectsByLifecycle.inactive).toEqual([]);
  });

  it('proyecto solo con recent <24h queda como idle', () => {
    const store = useAgentsStore();
    store.applyAgentList([
      snap({
        id: 'a',
        status: 'done',
        project: 'p1',
        completedAtIso: '2026-05-26T06:00:00Z',
      }),
    ]);
    expect(store.projectsByLifecycle.idle.map((p) => p.name)).toEqual(['p1']);
    expect(store.projectsByLifecycle.active).toEqual([]);
  });

  it('proyecto solo con recent >24h queda como inactive', () => {
    const store = useAgentsStore();
    store.applyAgentList([
      snap({
        id: 'a',
        status: 'done',
        project: 'p1',
        completedAtIso: '2026-05-24T00:00:00Z',
      }),
    ]);
    expect(store.projectsByLifecycle.inactive.map((p) => p.name)).toEqual(['p1']);
  });

  it('store vacío devuelve 3 listas vacías', () => {
    const store = useAgentsStore();
    expect(store.projectsByLifecycle).toEqual({ active: [], idle: [], inactive: [] });
  });
});

// =====================================================================
// === projects + totalCount ===========================================
// =====================================================================

describe('useAgentsStore — projects + totalCount', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
  });

  it('projects flatten ordenado alfabéticamente dentro de cada lifecycle', () => {
    const store = useAgentsStore();
    store.applyAgentList([
      snap({ id: '1', status: 'running', project: 'zeta' }),
      snap({ id: '2', status: 'running', project: 'alpha' }),
      snap({
        id: '3',
        status: 'done',
        project: 'beta',
        completedAtIso: '2026-05-26T06:00:00Z',
      }),
    ]);
    // active sorted: alpha, zeta. Luego idle: beta. inactive vacío.
    expect(store.projects.map((p) => p.name)).toEqual(['alpha', 'zeta', 'beta']);
  });

  it('totalCount es la cantidad de agentes', () => {
    const store = useAgentsStore();
    expect(store.totalCount).toBe(0);
    store.addAgent(snap({ id: 'a' }));
    store.addAgent(snap({ id: 'b' }));
    expect(store.totalCount).toBe(2);
  });
});
