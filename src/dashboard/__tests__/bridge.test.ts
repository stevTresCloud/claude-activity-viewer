/* ================================================================
 * bridge.test.ts — Tests del supervisor del dashboard.
 *
 * Cubre tres bloques:
 *   1. `runtimeToWireStatus`  — mapping puro runtime↔wire.
 *   2. `deriveProjectContext` — derivación project/task de cwd
 *      contra projectsRoot, workspaceFolders y fallback.
 *   3. `DashboardBridge`      — integración con `FakeAgentRunner`
 *      que reemite secuencias de `AgentEvent` y simula terminal,
 *      validando el wire `DashboardEventToWebview` resultante +
 *      hydrate desde globalState + cancel + ringbuffer.
 *
 * Decisiones de testing:
 *   - `node:child_process` mockeado a nivel módulo: el bridge usa
 *     `execFileSync('git', ['-C', cwd, ...])` para leer la branch
 *     activa. Sin mock el test gatillaría git contra paths
 *     ficticios y dejaría tiempo perdido + posible flakiness.
 *   - `vscode` resuelve al stub manual en `src/__mocks__/vscode.ts`
 *     (alias declarado en vitest.config.ts). Cada test resetea su
 *     estado al inicio para no heredar configuración entre casos.
 *   - `FakeAgentRunner`: re-implementación mínima del shape del
 *     runner real (`startAgent(config): Promise<AgentResult>`).
 *     Captura `onEvent` para que los tests puedan emitir eventos
 *     sintéticos y `finish()` para resolver con un AgentResult
 *     fabricado. Castea a `AgentRunner` con `as unknown as` —
 *     compone solo lo que el bridge consume.
 * ================================================================ */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// === Mock de node:child_process ===
//
// Declarado ANTES de cualquier import del bridge para que el resolve
// vea el stub. Devuelve cadena vacía: el bridge interpreta como "no
// es repo git / git no instalado" y deja branch = ''. Suficiente
// para tests que no se enfocan en branch.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => ''),
}));

import {
  DashboardBridge,
  deriveProjectContext,
  runtimeToWireStatus,
} from '../bridge';
import type {
  AgentRunConfig,
  AgentResult,
  AgentEvent,
} from '../../runtime/types';
import type { AgentRunner } from '../../runtime/agent-runner';
import type {
  AgentSnapshot,
  DashboardEventToWebview,
  LogEntry,
} from '../../shared/dashboard-protocol';
import {
  __resetVscode,
  __setConfig,
  __setWorkspaceFolders,
} from '../../__mocks__/vscode';

// =====================================================================
// === Helpers de test =================================================
// =====================================================================

/**
 * FakeAgentRunner — implementación mínima de la interfaz que el
 * bridge consume (`startAgent`). Mantiene la última config recibida
 * para que los tests puedan emitir eventos sintéticos via
 * `emit(event)` y cerrar la corrida con `finish(result)`.
 *
 * Cuando el bridge llama startAgent, devolvemos una promise que se
 * resuelve recién al `finish()`. Esto simula el await del runner
 * real y permite al test controlar el timing exacto.
 */
class FakeAgentRunner {
  public lastConfig: AgentRunConfig | undefined;
  public readonly abortSignals: AbortSignal[] = [];
  private resolver: ((r: AgentResult) => void) | undefined;

  startAgent(config: AgentRunConfig): Promise<AgentResult> {
    this.lastConfig = config;
    this.abortSignals.push(config.abortSignal);
    return new Promise<AgentResult>((resolve) => {
      this.resolver = resolve;
    });
  }

  emit(event: AgentEvent): void {
    if (!this.lastConfig) throw new Error('startAgent no fue llamado todavía');
    this.lastConfig.onEvent(event);
  }

  finish(partial: Partial<AgentResult> = {}): void {
    if (!this.resolver) throw new Error('No hay resolver activo');
    const result: AgentResult = {
      status: 'completed',
      finalResponse: null,
      toolCallCount: 0,
      durationMs: 1000,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      ...partial,
    };
    this.resolver(result);
    this.resolver = undefined;
  }
}

interface StoredAgentLike {
  snapshot: AgentSnapshot;
  cwd: string;
  prompt: string;
  log: LogEntry[];
}

/**
 * makeContext — fake ExtensionContext con `globalState` respaldado
 * por un Map en memoria. Cubre las APIs que el bridge usa: `get`,
 * `update`. Cada test recibe una instancia fresca.
 */
function makeContext() {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get<T>(key: string, defaultValue?: T): T {
        return (store.has(key) ? (store.get(key) as T) : (defaultValue as T));
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

/** Fake OutputChannel: solo necesita absorber appendLine. */
function makeOutputChannel() {
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

/**
 * emitUsage — fixture builder para AgentEvent type='usage'. Centraliza
 * los campos cache/cost que el bridge no inspecciona en estos tests
 * para evitar repetir el shape completo en cada caso.
 */
function emitUsage(runner: FakeAgentRunner, inputTokens: number, outputTokens: number): void {
  runner.emit({
    type: 'usage',
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  });
}

// =====================================================================
// === runtimeToWireStatus =============================================
// =====================================================================

describe('runtimeToWireStatus', () => {
  it('mapea running → running', () => {
    expect(runtimeToWireStatus('running')).toBe('running');
  });
  it('mapea completed → done (rename consciente runtime→wire)', () => {
    expect(runtimeToWireStatus('completed')).toBe('done');
  });
  it('mapea failed → failed', () => {
    expect(runtimeToWireStatus('failed')).toBe('failed');
  });
  it('mapea cancelled → cancelled', () => {
    expect(runtimeToWireStatus('cancelled')).toBe('cancelled');
  });

  it('forward-compat: status desconocido cae al fallback "failed"', () => {
    // El switch tiene `default: return 'failed'` con un guard
    // `_exhaustive: never` para que TS detecte branches nuevos en
    // compile-time. En runtime, si el runtime agrega un status sin
    // que el bridge lo conozca, queremos fallback explícito (no
    // undefined) para que la UI no rompa. Pasamos un valor fuera
    // del enum forzando el cast.
    expect(runtimeToWireStatus('unknown-status' as never)).toBe('failed');
  });
});

// =====================================================================
// === deriveProjectContext ============================================
// =====================================================================
//
// Helper puro: pasamos `workspaceFolders` explícito en cada caso
// para no depender del estado global del mock vscode. El branch se
// lee via execFileSync (mockeado a '') → siempre vacío en tests.

describe('deriveProjectContext', () => {
  it('extrae project y task de <root>/<project>/tasks/<task>/...', () => {
    const ctx = deriveProjectContext(
      '/repos/myproj/tasks/feature-x/sub/file.ts',
      ['/repos'],
      undefined,
      [],
    );
    expect(ctx.project).toBe('myproj');
    expect(ctx.task).toBe('feature-x');
  });

  it('extrae project con task vacío cuando no hay segmento tasks/', () => {
    const ctx = deriveProjectContext(
      '/repos/myproj/src/components',
      ['/repos'],
      undefined,
      [],
    );
    expect(ctx.project).toBe('myproj');
    expect(ctx.task).toBe('');
  });

  it('cuando cwd === root exacto cae a workspace folders coincidentes', () => {
    // Sin segments dentro del root, el for de projectsRoot matchea
    // pero `segments[0]` es '' (string vacía después del slice). El
    // bridge sale del loop sin setear project y cae a folders. Para
    // que este caso resuelva project necesitamos que algún folder
    // contenga al cwd — acá hacemos que el folder coincida con el
    // root mismo, así basename(folder) da el project esperado.
    const ctx = deriveProjectContext('/repos/myws', ['/repos/myws'], undefined, ['/repos/myws']);
    expect(ctx.project).toBe('myws');
  });

  it('expande tildes en cwd y projectsRoot', () => {
    const home = process.env.HOME ?? '';
    const ctx = deriveProjectContext(
      `${home}/git19/docs/foo/tasks/bar/x`,
      ['~/git19/docs'],
      undefined,
      [],
    );
    expect(ctx.project).toBe('foo');
    expect(ctx.task).toBe('bar');
  });

  it('normaliza .. en el cwd antes de matchear', () => {
    const ctx = deriveProjectContext(
      '/repos/myproj/sub/../tasks/x',
      ['/repos'],
      undefined,
      [],
    );
    expect(ctx.project).toBe('myproj');
    expect(ctx.task).toBe('x');
  });

  it('el override explícito gana sobre projectsRoot y workspaceFolders', () => {
    // Cuando entra por override, el path nunca se inspecciona —
    // task queda en su valor inicial '' por diseño (el override no
    // implica una convención de tasks/<x>/).
    const ctx = deriveProjectContext(
      '/repos/myproj/tasks/x/file',
      ['/repos'],
      'custom-name',
      ['/repos/myproj'],
    );
    expect(ctx.project).toBe('custom-name');
    expect(ctx.task).toBe('');
  });

  it('usa workspace folders cuando no matchea projectsRoot', () => {
    const ctx = deriveProjectContext(
      '/elsewhere/myws/sub',
      ['/repos'],
      undefined,
      ['/elsewhere/myws'],
    );
    expect(ctx.project).toBe('myws');
  });

  it('fallback basename(cwd) cuando no matchea projectsRoot ni folders', () => {
    const ctx = deriveProjectContext('/random/path/leaf', [], undefined, []);
    expect(ctx.project).toBe('leaf');
    expect(ctx.task).toBe('');
  });
});

// =====================================================================
// === DashboardBridge — integración con FakeAgentRunner ==============
// =====================================================================

describe('DashboardBridge — integración', () => {
  let bridge: DashboardBridge;
  let context: ReturnType<typeof makeContext>;
  let channel: ReturnType<typeof makeOutputChannel>;
  let runner: FakeAgentRunner;
  let webview: ReturnType<typeof makeWebview>;

  beforeEach(() => {
    __resetVscode();
    __setConfig('claudeOrchestrator', 'projectsRoot', ['/repos']);
    __setWorkspaceFolders([]);
    context = makeContext();
    channel = makeOutputChannel();
    runner = new FakeAgentRunner();
    webview = makeWebview();
    bridge = new DashboardBridge({
      // El bridge espera tipos VS Code; el shape de los fakes es
      // estructuralmente compatible con la subset que consume.
      context: context as never,
      channel: channel as never,
      runner: runner as unknown as AgentRunner,
    });
  });

  afterEach(async () => {
    // dispose() es idempotente: cancela activos, espera runs en
    // vuelo, limpia timer + flush final. Llamarlo siempre evita
    // setTimeouts pendientes entre tests (el debounce de 500ms
    // dejaría handles colgados sin esto).
    await bridge.dispose();
  });

  it('spawn retorna sync con agentId UUID y promise finished', () => {
    bridge.attachWebview(webview as never);
    const result = bridge.spawn({ prompt: 'hello', cwd: '/repos/myproj/tasks/x' });
    expect(result.agentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.finished).toBeInstanceOf(Promise);
    // Cerramos el agente para que el dispose no espere indefinido.
    runner.finish({ status: 'completed', durationMs: 1 });
  });

  it('postea agent_created al webview con snapshot inicial coherente', () => {
    bridge.attachWebview(webview as never);
    const { agentId } = bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    const created = postedOf(webview, 'agent_created');
    expect(created).toHaveLength(1);
    expect(created[0].agent.id).toBe(agentId);
    expect(created[0].agent.project).toBe('myproj');
    expect(created[0].agent.status).toBe('running');
    runner.finish({ status: 'completed', durationMs: 1 });
  });

  it('tool_use → agent_status_changed con currentTool + subtitle truncado', () => {
    bridge.attachWebview(webview as never);
    bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    runner.emit({
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/repos/myproj/src/app.ts' },
    });
    const changes = postedOf(webview, 'agent_status_changed');
    const last = changes[changes.length - 1];
    expect(last.metadata?.currentTool).toBe('Read');
    expect(last.metadata?.subtitle).toContain('app.ts');
    runner.finish();
  });

  it('usage → agent_status_changed con tokensUsed (suma input+output) y contextUsedPct', () => {
    bridge.attachWebview(webview as never);
    bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    // 100k input contra 200k context window → 50%.
    emitUsage(runner, 100_000, 2_000);
    const changes = postedOf(webview, 'agent_status_changed');
    const last = changes[changes.length - 1];
    expect(last.metadata?.tokensUsed).toBe(102_000);
    expect(last.metadata?.contextUsedPct).toBe(50);
    runner.finish();
  });

  it('al terminal emite UN agent_completed con duration y tokens definitivos', async () => {
    bridge.attachWebview(webview as never);
    const { agentId, finished } = bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    emitUsage(runner, 10_000, 1_000);
    runner.finish({
      status: 'completed',
      durationMs: 4321,
      inputTokens: 10_000,
      outputTokens: 1_000,
    });
    await finished;
    const completed = postedOf(webview, 'agent_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].agentId).toBe(agentId);
    expect(completed[0].result.status).toBe('done');
    expect(completed[0].result.durationMs).toBe(4321);
    expect(completed[0].result.tokensUsed).toBe(11_000);
  });

  it('cancel de agente activo retorna true y dispara abort en el runner', () => {
    bridge.attachWebview(webview as never);
    const { agentId } = bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    expect(bridge.cancel(agentId)).toBe(true);
    expect(runner.abortSignals[0]?.aborted).toBe(true);
    runner.finish({ status: 'cancelled', durationMs: 5 });
  });

  it('cancel de agente inexistente retorna false sin efectos', () => {
    expect(bridge.cancel('no-such-id')).toBe(false);
  });

  it('hydrate con globalState vacío deja el registry vacío y el agent_list lo refleja', async () => {
    await bridge.hydrate();
    bridge.attachWebview(webview as never);
    const lists = postedOf(webview, 'agent_list');
    expect(lists).toHaveLength(1);
    expect(lists[0].agents).toEqual([]);
  });

  it('hydrate marca agentes running huérfanos como failed/ide_restart', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const stored: StoredAgentLike[] = [
      {
        snapshot: {
          id: 'agent-x',
          name: 'x',
          status: 'running',
          project: 'p',
          task: '',
          branch: '',
          batchId: 'b',
          startedAtIso: past,
          elapsedMs: 0,
          tokensUsed: 0,
          contextUsedPct: 0,
        },
        cwd: '/repos/p',
        prompt: 'old',
        log: [],
      },
    ];
    await context.globalState.update('claudeOrchestrator.agents', stored);

    await bridge.hydrate();
    bridge.attachWebview(webview as never);
    const list = postedOf(webview, 'agent_list')[0];
    expect(list.agents).toHaveLength(1);
    expect(list.agents[0].status).toBe('failed');
    expect(list.agents[0].reason).toBe('ide_restart');
    expect(list.agents[0].completedAtIso).toBeDefined();
  });

  it('hydrate con completedAtIso malformado NO evicta (guard defensivo)', async () => {
    // Si Date.parse devuelve NaN, `now - NaN > TTL_MS` es false →
    // el item sobrevive. Comportamiento conservador deseado: ante
    // un ISO corrupto en globalState no descartamos al ciegas, lo
    // dejamos para que el usuario pueda diagnosticarlo en RECENT.
    const stored: StoredAgentLike[] = [
      {
        snapshot: {
          id: 'bad-iso',
          name: 'b',
          status: 'done',
          project: 'p',
          task: '',
          branch: '',
          batchId: 'b',
          completedAtIso: 'not-an-iso',
        },
        cwd: '/repos/p',
        prompt: 'x',
        log: [],
      },
    ];
    await context.globalState.update('claudeOrchestrator.agents', stored);
    await bridge.hydrate();
    bridge.attachWebview(webview as never);
    const list = postedOf(webview, 'agent_list')[0];
    expect(list.agents).toHaveLength(1);
    expect(list.agents[0].id).toBe('bad-iso');
  });

  it('hydrate evicta items completados hace más de 30 días', async () => {
    const veryOld = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const stored: StoredAgentLike[] = [
      {
        snapshot: {
          id: 'old',
          name: 'o',
          status: 'done',
          project: 'p',
          task: '',
          branch: '',
          batchId: 'b',
          completedAtIso: veryOld,
        },
        cwd: '/repos/p',
        prompt: 'old',
        log: [],
      },
    ];
    await context.globalState.update('claudeOrchestrator.agents', stored);

    await bridge.hydrate();
    bridge.attachWebview(webview as never);
    const list = postedOf(webview, 'agent_list')[0];
    expect(list.agents).toEqual([]);
  });

  it('attachWebview post-spawn emite agent_list con el snapshot vigente', () => {
    // Attach DESPUÉS del spawn: el agent_created se perdió (no había
    // webview para postear), pero el list debe re-hidratar al
    // webview con el agente vivo del registry.
    const { agentId } = bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    bridge.attachWebview(webview as never);
    const list = postedOf(webview, 'agent_list')[0];
    expect(list.agents).toHaveLength(1);
    expect(list.agents[0].id).toBe(agentId);
    runner.finish();
  });

  it('ringbuffer per-agent FIFO: el log se acota a 1000 entries descartando el más viejo', async () => {
    bridge.attachWebview(webview as never);
    const { agentId, finished } = bridge.spawn({
      prompt: 'hi',
      cwd: '/repos/myproj',
    });
    // Emitimos 1001 eventos `text` (cada uno → 1 LogEntry).
    for (let i = 0; i < 1001; i++) {
      runner.emit({ type: 'text', text: `entry-${i}` });
    }
    runner.finish({ status: 'completed', durationMs: 1 });
    await finished;
    // dispose para forzar flush sync del globalState.
    await bridge.dispose();
    const stored = context.globalState.get<StoredAgentLike[]>(
      'claudeOrchestrator.agents',
      [],
    );
    const ours = stored.find((s) => s.snapshot.id === agentId);
    expect(ours).toBeDefined();
    expect(ours?.log).toHaveLength(1000);
    // El entry-0 quedó evicted (FIFO). El más viejo ahora es entry-1.
    expect(ours?.log[0]?.text).toBe('entry-1');
    expect(ours?.log[999]?.text).toBe('entry-1000');
  });
});
