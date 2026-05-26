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
  deriveProjectContextPure,
  derivePathFromPrompt,
  prettyModel,
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
import { makeContext, makeOutputChannel } from './_fixtures';

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
// === prettyModel =====================================================
// =====================================================================

describe('prettyModel', () => {
  it('id largo de Sonnet 4.5 → "Sonnet 4.5"', () => {
    expect(prettyModel('claude-sonnet-4-5-20251022')).toBe('Sonnet 4.5');
  });
  it('id largo de Opus 4.7 → "Opus 4.7"', () => {
    expect(prettyModel('claude-opus-4-7-20260101')).toBe('Opus 4.7');
  });
  it('id largo de Haiku → "Haiku <ver>"', () => {
    expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });
  it('id largo sin sufijo de fecha también matchea', () => {
    expect(prettyModel('claude-sonnet-4-5')).toBe('Sonnet 4.5');
  });
  it('alias corto "sonnet" → "Sonnet"', () => {
    expect(prettyModel('sonnet')).toBe('Sonnet');
  });
  it('alias corto "opus" → "Opus"', () => {
    expect(prettyModel('opus')).toBe('Opus');
  });
  it('familia futura sigue el mismo formato (forward-compat)', () => {
    // Un futuro "claude-something-1-0-20300101" debería pintar
    // "Something 1.0" en vez de quedar como id raw. La regex acepta
    // cualquier slug de letras como family.
    expect(prettyModel('claude-something-1-0-20300101')).toBe('Something 1.0');
  });
  it('id que no matchea el shape "claude-<family>-<X>-<Y>" se devuelve raw', () => {
    // Sin la estructura family+major+minor, no pintamos.
    expect(prettyModel('gpt-4-turbo')).toBe('gpt-4-turbo');
  });
  it('string vacío retorna vacío', () => {
    expect(prettyModel('')).toBe('');
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
// === derivePathFromPrompt + heurística del primer prompt ============
// =====================================================================

describe('derivePathFromPrompt', () => {
  const ROOTS = ['/home/trescloud/git19/docs'];

  it('extrae project del primer path absoluto que matchee un root', () => {
    const prompt =
      'Necesito mover el módulo /home/trescloud/git19/docs/equipo-ya/src/foo.py';
    const out = derivePathFromPrompt(prompt, ROOTS);
    expect(out).toEqual({ project: 'equipo-ya', task: '' });
  });

  it('extrae task cuando el path matchea la convención tasks/<task>', () => {
    const prompt =
      'En la tarea /home/trescloud/git19/docs/equipo-ya/tasks/hr18/spec.md';
    const out = derivePathFromPrompt(prompt, ROOTS);
    expect(out).toEqual({ project: 'equipo-ya', task: 'hr18' });
  });

  it('devuelve null cuando ningún path en el prompt matchea un root', () => {
    const prompt = 'Mira /tmp/random/foo.py y /etc/hosts';
    expect(derivePathFromPrompt(prompt, ROOTS)).toBe(null);
  });

  it('ignora URLs http:// y otras menciones que no son paths absolutos', () => {
    const prompt =
      'Mira https://example.com/path/algo y luego /home/trescloud/git19/docs/equipo-ya/main.ts';
    const out = derivePathFromPrompt(prompt, ROOTS);
    expect(out).toEqual({ project: 'equipo-ya', task: '' });
  });

  it('el PRIMER path que matchea gana (no el último)', () => {
    const prompt =
      'Compara /home/trescloud/git19/docs/equipo-ya/x con /home/trescloud/git19/docs/otra-tarea/y';
    const out = derivePathFromPrompt(prompt, ROOTS);
    expect(out).toEqual({ project: 'equipo-ya', task: '' });
  });

  it('respeta múltiples projectsRoot, el primer match gana', () => {
    const roots = ['/home/trescloud/git18/docs', '/home/trescloud/git19/docs'];
    const prompt = 'Trabaja en /home/trescloud/git19/docs/proj/file.ts';
    expect(derivePathFromPrompt(prompt, roots)).toEqual({
      project: 'proj',
      task: '',
    });
  });

  it('devuelve null para prompt vacío', () => {
    expect(derivePathFromPrompt('', ROOTS)).toBe(null);
  });

  it('devuelve null cuando no hay projectsRoot configurados', () => {
    const prompt = 'Necesito /home/trescloud/git19/docs/equipo-ya/foo.py';
    expect(derivePathFromPrompt(prompt, [])).toBe(null);
  });

  // === Heurística v2: paths relativos resueltos contra cwd ===

  it('resuelve paths relativos contra baseCwd', () => {
    // Caso real: tool_use con file_path="docs/equipo-ya/foo.py" y
    // cwd del .jsonl = /home/trescloud/git19. Sin baseCwd no
    // match-ea; con baseCwd resuelve a /home/trescloud/git19/docs/equipo-ya/foo.py.
    const out = derivePathFromPrompt(
      'tool input: docs/equipo-ya/tasks/hr18/main.py',
      ['/home/trescloud/git19/docs'],
      '/home/trescloud/git19',
    );
    expect(out).toEqual({ project: 'equipo-ya', task: 'hr18' });
  });

  it('paths absolutos del prompt ganan sobre relativos del mismo prompt', () => {
    // Si en el mismo texto hay un path absoluto que matchea Y un
    // relativo, el absoluto se procesa primero (más específico).
    const out = derivePathFromPrompt(
      'Mira /home/trescloud/git19/docs/proj-a/foo y también docs/proj-b/bar',
      ['/home/trescloud/git19/docs'],
      '/home/trescloud/git19',
    );
    expect(out).toEqual({ project: 'proj-a', task: '' });
  });

  it('no matchea URLs http como paths relativos', () => {
    // Antes del fix: "github.com/user/repo" se intentaba resolver
    // contra baseCwd y podía dar matches espurios.
    const out = derivePathFromPrompt(
      'Ver https://github.com/user/repo/foo y luego docs/proj-real/bar',
      ['/home/trescloud/git19/docs'],
      '/home/trescloud/git19',
    );
    expect(out).toEqual({ project: 'proj-real', task: '' });
  });

  it('no matchea dominios sueltos (host con punto) como paths', () => {
    // Caso "example.com/path/foo" o "anthropic.com/api/x" — no son
    // paths del filesystem.
    const out = derivePathFromPrompt(
      'Mira example.com/foo/bar.html y luego docs/proj-real/bar',
      ['/home/trescloud/git19/docs'],
      '/home/trescloud/git19',
    );
    expect(out).toEqual({ project: 'proj-real', task: '' });
  });

  it('skip de path relativo sin baseCwd (defensivo)', () => {
    // Sin baseCwd no podemos resolver paths relativos; no inventar
    // (mismo criterio que sin projectsRoot).
    const out = derivePathFromPrompt('docs/equipo-ya/foo', [
      '/home/trescloud/git19/docs',
    ]);
    expect(out).toBe(null);
  });
});

describe('deriveProjectContextPure — heurística v2 con signalText', () => {
  const ROOTS = ['/home/trescloud/git19/docs'];

  it('usa signalText cuando el primer prompt es conversacional sin paths', () => {
    // Caso "Continuamos con el PR #285 — Fase 4": primer prompt
    // conversacional, los tool_use posteriores sí mencionan el path.
    // El primer path relativo que matchea gana — capturamos project
    // pero no necesariamente task (depende de qué path entra primero).
    const ctx = deriveProjectContextPure(
      '/home/trescloud/git19',
      ROOTS,
      undefined,
      [],
      'Continuamos con el PR #285 — Correcciones de observaciones, Fase 4',
      'docs/equipo-ya/main.py',
    );
    expect(ctx).toEqual({ project: 'equipo-ya', task: '' });
  });

  it('extrae task cuando el path en signalText respeta la convención tasks/X', () => {
    const ctx = deriveProjectContextPure(
      '/home/trescloud/git19',
      ROOTS,
      undefined,
      [],
      undefined,
      'docs/equipo-ya/tasks/hr18/spec.md',
    );
    expect(ctx).toEqual({ project: 'equipo-ya', task: 'hr18' });
  });

  it('primer prompt absoluto gana sobre signalText (ambos válidos)', () => {
    const ctx = deriveProjectContextPure(
      '/home/trescloud/git19',
      ROOTS,
      undefined,
      [],
      'En /home/trescloud/git19/docs/proj-primer/foo',
      'docs/proj-otro/bar',
    );
    expect(ctx).toEqual({ project: 'proj-primer', task: '' });
  });

  it('PROMPT gana sobre workspace folder cuando ambos podrían matchear (orden de prioridad)', () => {
    // Repro del bug visible en smoke E2E: workspace VS Code = ~/git18,
    // cwd del .jsonl = /home/trescloud/git18 (igual al workspace),
    // prompts mencionan docs/ecuadorian-hr18/... Sin el reorden,
    // workspaceFolders match-eaba primero y daba project='git18'.
    const ctx = deriveProjectContextPure(
      '/home/trescloud/git18',
      ROOTS, // ['/home/trescloud/git19/docs'] no aplica al git18
      undefined,
      ['/home/trescloud/git18'], // workspace folders
      undefined,
      '/home/trescloud/git19/docs/equipo-ya/foo.py',
    );
    // Como projectsRoot apunta a git19, el match va por ahí.
    expect(ctx).toEqual({ project: 'equipo-ya', task: '' });
  });

  it('repro del workspace=~/git18 + prompts apuntando a docs/X (caso Trescloud)', () => {
    // Setup más realista: projectsRoot apunta a git18/docs, el
    // workspace es git18 entero, prompts mencionan docs/X.
    const ctx = deriveProjectContextPure(
      '/home/trescloud/git18',
      ['/home/trescloud/git18/docs'],
      undefined,
      ['/home/trescloud/git18'],
      'Continuamos con el PR de docs/ecuadorian-hr18/tasks/hr18/main.py',
    );
    expect(ctx).toEqual({ project: 'ecuadorian-hr18', task: 'hr18' });
  });

  it('cuando solo signalText tiene paths, lo usa', () => {
    const ctx = deriveProjectContextPure(
      '/home/trescloud/git19',
      ROOTS,
      undefined,
      [],
      'texto sin paths',
      '/home/trescloud/git19/docs/proj-signal/file.py',
    );
    expect(ctx).toEqual({ project: 'proj-signal', task: '' });
  });
});

describe('deriveProjectContextPure — heurística del prompt como fallback', () => {
  const ROOTS = ['/home/trescloud/git19/docs'];

  it('usa el prompt cuando el cwd genérico no matchea (caso Trescloud)', () => {
    // Caso real del smoke E2E: VS Code workspace = ~/git19/, prompt
    // habla de un path dentro de ~/git19/docs/equipo-ya.
    const ctx = deriveProjectContextPure(
      '/home/trescloud/git19',
      ROOTS,
      undefined,
      [],
      'Trabaja en /home/trescloud/git19/docs/equipo-ya/tasks/hr18/main.py',
    );
    expect(ctx).toEqual({ project: 'equipo-ya', task: 'hr18' });
  });

  it('prefiere el match del cwd sobre el prompt cuando AMBOS aplican', () => {
    // El cwd ya nos dijo "proj-real". El prompt menciona otro path
    // dentro de un root distinto — no debe pisar lo que ya tenemos.
    const ctx = deriveProjectContextPure(
      '/home/trescloud/git19/docs/proj-real/tasks/x',
      ROOTS,
      undefined,
      [],
      'Mira /home/trescloud/git19/docs/proj-impostor/foo.py',
    );
    expect(ctx).toEqual({ project: 'proj-real', task: 'x' });
  });

  it('cae a basename(cwd) si prompt tampoco tiene paths matcheando', () => {
    const ctx = deriveProjectContextPure(
      '/home/trescloud/git19',
      ROOTS,
      undefined,
      [],
      'Texto sin paths absolutos',
    );
    expect(ctx).toEqual({ project: 'git19', task: '' });
  });

  it('no se activa si no hay projectsRoot (evita inferencias falsas)', () => {
    const ctx = deriveProjectContextPure(
      '/home/trescloud/git19',
      [],
      undefined,
      [],
      'Mira /home/trescloud/git19/docs/foo',
    );
    expect(ctx).toEqual({ project: 'git19', task: '' });
  });

  it('no requiere prompt: si no se pasa, se salta el paso 3 sin tirar', () => {
    const ctx = deriveProjectContextPure(
      '/home/trescloud/git19',
      ROOTS,
      undefined,
      [],
    );
    expect(ctx).toEqual({ project: 'git19', task: '' });
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

  it('contextUsedPct + contextTokens INCLUYEN cache tokens; tokensUsed sigue siendo billable del turn', () => {
    // Repro del bug: el SDK reporta input_tokens=1 y output_tokens=8
    // pero cache_read_input_tokens=105583 + cache_creation_input_tokens=14254.
    // El contexto activo REAL son los ~120k de cache, no los 9 tokens
    // nuevos. Sin esto el ContextBar quedaba en 0% durante todo
    // el run porque casi todo viaja por el prompt cache de Anthropic.
    bridge.attachWebview(webview as never);
    bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    runner.emit({
      type: 'usage',
      inputTokens: 1,
      outputTokens: 8,
      cacheReadTokens: 105_583,
      cacheCreationTokens: 14_254,
      costUsd: 0,
    });
    const changes = postedOf(webview, 'agent_status_changed');
    const last = changes[changes.length - 1];
    // tokensUsed = 1 + 8 = 9 (costo billable del turn, sin cache).
    expect(last.metadata?.tokensUsed).toBe(9);
    // contextTokens = 1 + 105583 + 14254 = 119838 (context activo,
    // suma input+cacheRead+cacheCreation; matchea matemáticamente
    // con el porcentaje).
    expect(last.metadata?.contextTokens).toBe(119_838);
    // contextUsedPct = 119838 / 200000 = 59.92% → 60%.
    expect(last.metadata?.contextUsedPct).toBe(60);
    runner.finish();
  });

  it('usage events sucesivos REEMPLAZAN, no acumulan (semántica "context activo ahora")', () => {
    // El runner emite un usage event por cada `assistant` message
    // del SDK (cada turno trae su propio context window). El bridge
    // debe reemplazar el último valor — no sumar — porque
    // `input_tokens` ya incluye el contexto histórico del turno.
    // Si sumáramos, el ContextBar dispararía al 200% en pocos
    // turnos.
    bridge.attachWebview(webview as never);
    bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    emitUsage(runner, 20_000, 500);
    emitUsage(runner, 50_000, 1_500);
    emitUsage(runner, 80_000, 2_000);
    const changes = postedOf(webview, 'agent_status_changed').filter(
      (c) => c.metadata?.tokensUsed !== undefined,
    );
    expect(changes).toHaveLength(3);
    // Último valor refleja la última invocación (80k+2k=82k, 40%),
    // NO la suma 150k+4k.
    const last = changes[changes.length - 1];
    expect(last.metadata?.tokensUsed).toBe(82_000);
    expect(last.metadata?.contextUsedPct).toBe(40);
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

  it('onAttach: callbacks registrados se ejecutan al attach', () => {
    // Repro del bug visible en smoke E2E: el scanner-controller
    // necesitaba retransmitir su último resultado cuando el sidebar
    // se cerraba y reabría. Sin onAttach, el webview re-attachado
    // quedaba con la sección PAST SESSIONS vacía.
    const calls: string[] = [];
    const off1 = bridge.onAttach(() => calls.push('a'));
    bridge.onAttach(() => calls.push('b'));
    bridge.attachWebview(webview as never);
    expect(calls).toEqual(['a', 'b']);
    // Detach + re-attach: callbacks deben volver a dispararse para
    // hidratar el nuevo webview.
    bridge.detachWebview(webview as never);
    const webview2 = makeWebview();
    bridge.attachWebview(webview2 as never);
    expect(calls).toEqual(['a', 'b', 'a', 'b']);
    // Des-registro: off1 deja de dispararse, off2 sigue.
    off1();
    const webview3 = makeWebview();
    bridge.attachWebview(webview3 as never);
    expect(calls).toEqual(['a', 'b', 'a', 'b', 'b']);
  });

  it('onAttach: un callback que tira NO rompe attach ni siguientes callbacks', () => {
    // Guardia defensiva del bridge — un scanner roto no debe dejar
    // el webview sin agent_list.
    const calls: string[] = [];
    bridge.onAttach(() => {
      throw new Error('boom');
    });
    bridge.onAttach(() => calls.push('survived'));
    expect(() => bridge.attachWebview(webview as never)).not.toThrow();
    expect(calls).toEqual(['survived']);
    expect(postedOf(webview, 'agent_list')).toHaveLength(1);
  });

  it('snapshot inicial usa "Sonnet" cuando el caller no pide modelo', () => {
    bridge.attachWebview(webview as never);
    bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    const created = postedOf(webview, 'agent_created')[0];
    expect(created.agent.model).toBe('Sonnet');
    runner.finish();
  });

  it('snapshot inicial respeta SpawnInput.model (alias)', () => {
    bridge.attachWebview(webview as never);
    bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj', model: 'opus' });
    const created = postedOf(webview, 'agent_created')[0];
    expect(created.agent.model).toBe('Opus');
    // El bridge debe forward-ear el alias al runner para que el SDK
    // lo use de verdad (sin esto, el badge mentiría diciendo Opus
    // mientras el SDK corre sonnet).
    expect(runner.lastConfig?.model).toBe('opus');
    runner.finish();
  });

  it('sin input.model usa setting `defaultModel` del user', () => {
    // El user configuró `defaultModel=haiku` en su settings.json.
    // El MCP call no especificó model → bridge debe leer el setting
    // y forward-earlo al runner.
    __setConfig('claudeOrchestrator', 'defaultModel', 'haiku');
    bridge.attachWebview(webview as never);
    bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    const created = postedOf(webview, 'agent_created')[0];
    expect(created.agent.model).toBe('Haiku');
    expect(runner.lastConfig?.model).toBe('haiku');
    runner.finish();
  });

  it('input.model gana sobre el setting defaultModel (override explícito)', () => {
    __setConfig('claudeOrchestrator', 'defaultModel', 'haiku');
    bridge.attachWebview(webview as never);
    bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj', model: 'opus' });
    expect(runner.lastConfig?.model).toBe('opus');
    runner.finish();
  });

  it('setting defaultModel con valor inválido cae al fallback "sonnet"', () => {
    // Defensa contra settings.json viejos/manipulados: si el setting
    // tiene un valor fuera del enum, NO lo pasamos al runner —
    // caemos al DEFAULT_MODEL hardcoded para que el SDK no rechace.
    __setConfig('claudeOrchestrator', 'defaultModel', 'gpt-4');
    bridge.attachWebview(webview as never);
    bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    expect(runner.lastConfig?.model).toBe('sonnet');
    runner.finish();
  });

  it('AgentEvent type=model reemplaza el badge con la versión real del SDK', () => {
    bridge.attachWebview(webview as never);
    bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    // El SDK reporta el id largo en system.init; el runner lo emite
    // como evento `model`. El bridge debe formatear y emitir status
    // change con el label nuevo.
    runner.emit({ type: 'model', name: 'claude-sonnet-4-5-20251022' });
    const changes = postedOf(webview, 'agent_status_changed');
    const withModel = changes.find((c) => c.metadata?.model !== undefined);
    expect(withModel?.metadata?.model).toBe('Sonnet 4.5');
    runner.finish();
  });

  it('AgentEvent session_id propaga al snapshot vía agent_status_changed', () => {
    bridge.attachWebview(webview as never);
    const { agentId } = bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    runner.emit({
      type: 'session_id',
      sessionId: 'deadbeef-1234-4abc-9def-012345678abc',
    });
    const changes = postedOf(webview, 'agent_status_changed');
    const withSession = changes.find((c) => c.metadata?.sessionId !== undefined);
    expect(withSession).toBeDefined();
    expect(withSession?.metadata?.sessionId).toBe(
      'deadbeef-1234-4abc-9def-012345678abc',
    );
    // El registry interno también lo recuerda (lo consume el handler
    // request_open vía getResumeTarget).
    expect(bridge.getResumeTarget(agentId)?.sessionId).toBe(
      'deadbeef-1234-4abc-9def-012345678abc',
    );
    runner.finish();
  });

  it('getResumeTarget retorna sessionId + cwd + name; null si no existe', () => {
    bridge.attachWebview(webview as never);
    const { agentId } = bridge.spawn({
      name: 'my-agent',
      prompt: 'hi',
      cwd: '/repos/myproj/tasks/x',
    });
    const meta = bridge.getResumeTarget(agentId);
    expect(meta).toEqual({
      sessionId: undefined,
      cwd: '/repos/myproj/tasks/x',
      name: 'my-agent',
    });
    expect(bridge.getResumeTarget('no-such-id')).toBeNull();
    runner.finish();
  });

  it('onRunningCountChange emite count actual al suscribirse y tras cada delta', async () => {
    const calls: number[] = [];
    const unsubscribe = bridge.onRunningCountChange((n) => calls.push(n));
    // Suscripción inicial: count=0 (sin spawns todavía).
    expect(calls[0]).toBe(0);

    bridge.attachWebview(webview as never);
    const { agentId, finished } = bridge.spawn({
      prompt: 'hi',
      cwd: '/repos/myproj',
    });
    // Tras spawn el running count subió a 1.
    expect(calls.at(-1)).toBe(1);

    // Cerrar el agente baja el count a 0.
    runner.finish({ status: 'completed', durationMs: 1 });
    await finished;
    expect(calls.at(-1)).toBe(0);

    // Des-registrar: spawns posteriores ya no notifican.
    unsubscribe();
    const lenBefore = calls.length;
    bridge.spawn({ prompt: 'hi2', cwd: '/repos/myproj' });
    expect(calls.length).toBe(lenBefore);
    runner.finish({ status: 'completed', durationMs: 1 });
    // Limpieza del registry para que el agentId no quede colgando
    // entre tests si afterEach falla.
    expect(agentId).toBeDefined();
  });

  it('onAgentCompleted dispara una vez por agente cuando llega a terminal', async () => {
    bridge.attachWebview(webview as never);
    const events: Array<{ agentId: string; name: string; status: string }> = [];
    const unsubscribe = bridge.onAgentCompleted((e) => {
      events.push({ agentId: e.agentId, name: e.name, status: e.status });
    });
    const { agentId, finished } = bridge.spawn({
      name: 'my-agent',
      prompt: 'hi',
      cwd: '/repos/myproj',
    });
    runner.finish({ status: 'completed', durationMs: 4321 });
    await finished;
    expect(events).toHaveLength(1);
    expect(events[0].agentId).toBe(agentId);
    expect(events[0].name).toBe('my-agent');
    expect(events[0].status).toBe('done');
    unsubscribe();
  });

  it('onAgentCompleted: status failed/cancelled también dispara', async () => {
    bridge.attachWebview(webview as never);
    const events: Array<{ status: string }> = [];
    bridge.onAgentCompleted((e) => events.push({ status: e.status }));
    const { finished } = bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    runner.finish({ status: 'failed', durationMs: 100, finalResponse: 'oom' });
    await finished;
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('failed');
  });

  it('onAgentCompleted: listener que tira no rompe al siguiente', async () => {
    bridge.attachWebview(webview as never);
    const survivors: string[] = [];
    bridge.onAgentCompleted(() => {
      throw new Error('boom');
    });
    bridge.onAgentCompleted((e) => survivors.push(e.agentId));
    const { agentId, finished } = bridge.spawn({
      prompt: 'hi',
      cwd: '/repos/myproj',
    });
    runner.finish({ status: 'completed', durationMs: 1 });
    await finished;
    expect(survivors).toEqual([agentId]);
  });

  it('onAgentCompleted: unsubscribe deja de recibir notifs', async () => {
    bridge.attachWebview(webview as never);
    const events: string[] = [];
    const unsub = bridge.onAgentCompleted((e) => events.push(e.agentId));
    unsub();
    const { finished } = bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    runner.finish({ status: 'completed', durationMs: 1 });
    await finished;
    expect(events).toHaveLength(0);
  });

  it('hydrateLogs emite agent_log_history con todo el ringbuffer del agente', () => {
    bridge.attachWebview(webview as never);
    const { agentId, finished } = bridge.spawn({
      prompt: 'hi',
      cwd: '/repos/myproj',
    });
    runner.emit({ type: 'text', text: 'first' });
    runner.emit({ type: 'text', text: 'second' });
    runner.emit({ type: 'tool_use', name: 'Read', input: { file_path: '/x.ts' } });

    bridge.hydrateLogs(agentId);

    const histories = postedOf(webview, 'agent_log_history');
    expect(histories).toHaveLength(1);
    expect(histories[0].agentId).toBe(agentId);
    expect(histories[0].entries).toHaveLength(3);
    expect(histories[0].entries[0].kind).toBe('text');
    expect(histories[0].entries[2].kind).toBe('tool_use');

    runner.finish();
    return finished;
  });

  it('listAgents retorna agentes en insertion-order como shallow copies', async () => {
    // Hacemos 2 spawns secuenciales, finalizando el primero antes
    // del segundo: el FakeAgentRunner solo soporta un resolver
    // activo, y el afterEach del describe espera Promise.allSettled
    // de los runs antes del flush.
    bridge.attachWebview(webview as never);
    const r1 = bridge.spawn({ name: 'first', prompt: 'a', cwd: '/repos/p1' });
    runner.finish({ status: 'completed', durationMs: 1 });
    await r1.finished;
    const r2 = bridge.spawn({ name: 'second', prompt: 'b', cwd: '/repos/p2' });

    const list = bridge.listAgents();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(r1.agentId);
    expect(list[1].id).toBe(r2.agentId);
    expect(list[0].name).toBe('first');
    expect(list[1].name).toBe('second');

    // Shallow copy: mutar el resultado no afecta al registry.
    list[0].name = 'mutated';
    expect(bridge.listAgents()[0].name).toBe('first');

    runner.finish({ status: 'completed', durationMs: 1 });
    await r2.finished;
  });

  it('getAgentLog retorna entries del agente; null si no existe', () => {
    bridge.attachWebview(webview as never);
    const { agentId, finished } = bridge.spawn({ prompt: 'hi', cwd: '/repos/p' });
    runner.emit({ type: 'text', text: 'e1' });
    runner.emit({ type: 'text', text: 'e2' });

    const result = bridge.getAgentLog(agentId);
    expect(result).not.toBeNull();
    expect(result?.entries).toHaveLength(2);
    expect(result?.entries[0]?.text).toBe('e1');

    expect(bridge.getAgentLog('no-such-id')).toBeNull();

    runner.finish();
    return finished;
  });

  it('getAgentLog filtra por `since` (ts > since)', async () => {
    // Usamos fake timers para que cada emit tenga un ts distinto.
    // Sin esto, los 3 entries pueden caer en el mismo Date.now() y
    // el filter `>since` retorna ninguno.
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    bridge.attachWebview(webview as never);
    const { agentId, finished } = bridge.spawn({ prompt: 'hi', cwd: '/repos/p' });

    runner.emit({ type: 'text', text: 'a' });
    vi.advanceTimersByTime(10);
    runner.emit({ type: 'text', text: 'b' });
    vi.advanceTimersByTime(10);
    runner.emit({ type: 'text', text: 'c' });

    const all = bridge.getAgentLog(agentId)?.entries ?? [];
    expect(all).toHaveLength(3);

    // Pedimos entries con ts > el del segundo → solo el tercero queda.
    const tsCut = all[1].ts;
    const filtered = bridge.getAgentLog(agentId, tsCut)?.entries ?? [];
    expect(filtered).toHaveLength(1);
    expect(filtered[0].text).toBe('c');

    // since del último → array vacío.
    const tsLast = all[2].ts;
    expect(bridge.getAgentLog(agentId, tsLast)?.entries).toEqual([]);

    vi.useRealTimers();
    runner.finish({ status: 'completed', durationMs: 1 });
    await finished;
  });

  it('hydrateLogs con agentId inexistente emite entries vacíos (no-op silencioso)', () => {
    bridge.attachWebview(webview as never);
    bridge.hydrateLogs('no-such-agent');
    const histories = postedOf(webview, 'agent_log_history');
    expect(histories).toHaveLength(1);
    expect(histories[0].agentId).toBe('no-such-agent');
    expect(histories[0].entries).toEqual([]);
  });

  it('hydrateLogs con targetWebview envía SOLO a ese webview (no broadcast)', () => {
    // Critical: el detail panel pasa su propio webview para evitar
    // que el sidebar reciba 1000 entries que no usa. Si alguien
    // revierte el `if (targetWebview)` del bridge, este test rompe.
    const webview2 = makeWebview();
    bridge.attachWebview(webview as never);
    bridge.attachWebview(webview2 as never);
    const { agentId, finished } = bridge.spawn({
      prompt: 'hi',
      cwd: '/repos/myproj',
    });
    runner.emit({ type: 'text', text: 'entry-1' });

    // Hydrate dirigido SOLO a webview2.
    bridge.hydrateLogs(agentId, webview2 as never);

    const w1History = postedOf(webview, 'agent_log_history');
    const w2History = postedOf(webview2, 'agent_log_history');
    expect(w1History).toHaveLength(0);
    expect(w2History).toHaveLength(1);
    expect(w2History[0].entries).toHaveLength(1);

    runner.finish({ status: 'completed', durationMs: 1 });
    return finished;
  });

  it('multi-webview broadcast: post() llega a TODOS los webviews attached', async () => {
    // Sidebar attache primero (sin agentes en el registry).
    bridge.attachWebview(webview as never);

    // Spawn de un agente.
    const { agentId, finished } = bridge.spawn({
      prompt: 'hi',
      cwd: '/repos/myproj',
    });
    runner.emit({ type: 'text', text: 'broadcast me' });

    // AHORA attache un segundo webview (simulando detail panel
    // abierto on-demand después de que el agente ya está vivo).
    const webview2 = makeWebview();
    bridge.attachWebview(webview2 as never);

    // El sidebar recibió agent_created + agent_log (eventos
    // broadcasteados después de su attach).
    expect(postedOf(webview, 'agent_created')).toHaveLength(1);
    expect(postedOf(webview, 'agent_log')).toHaveLength(1);
    // El sidebar recibió agent_list SOLO al attach inicial (0 agents).
    const lists1 = postedOf(webview, 'agent_list');
    expect(lists1).toHaveLength(1);
    expect(lists1[0].agents).toHaveLength(0);

    // El detail panel (webview2) recibió SU agent_list al attach
    // con el agente ya vivo en el registry.
    const lists2 = postedOf(webview2, 'agent_list');
    expect(lists2).toHaveLength(1);
    expect(lists2[0].agents).toHaveLength(1);
    expect(lists2[0].agents[0].id).toBe(agentId);

    // Emit posterior llega a AMBOS (broadcast).
    runner.emit({ type: 'text', text: 'after attach' });
    const logs1 = postedOf(webview, 'agent_log');
    const logs2 = postedOf(webview2, 'agent_log');
    expect(logs1.length).toBeGreaterThanOrEqual(2);
    expect(logs2.length).toBeGreaterThanOrEqual(1);

    runner.finish({ status: 'completed', durationMs: 1 });
    await finished;
  });

  it('detachWebview saca al webview del broadcast sin afectar a los demás', async () => {
    const webview2 = makeWebview();
    bridge.attachWebview(webview as never);
    const token2 = bridge.attachWebview(webview2 as never);

    bridge.detachWebview(token2);

    const { finished } = bridge.spawn({ prompt: 'hi', cwd: '/repos/myproj' });
    runner.emit({ type: 'text', text: 'only webview' });
    runner.finish();
    await finished;

    // Solo el sidebar (webview) recibió eventos post-detach.
    expect(postedOf(webview, 'agent_log').length).toBeGreaterThan(0);
    expect(postedOf(webview2, 'agent_log')).toHaveLength(0);
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
