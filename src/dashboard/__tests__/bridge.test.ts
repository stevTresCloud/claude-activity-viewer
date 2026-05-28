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
  // execFile async para captureCriticDiff (promisify(execFile)). El
  // mock acepta el callback firmado por util.promisify: (err, stdout, stderr).
  // Tests configuran retornos via mockImplementationOnce.
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, '', '');
    },
  ),
}));

import * as childProcess from 'node:child_process';
import {
  DashboardBridge,
  captureCriticDiff,
  deriveProjectContext,
  deriveProjectContextPure,
  derivePathFromPrompt,
  prettyModel,
  readGitHead,
  runtimeToWireStatus,
} from '../bridge';
import {
  TERMINAL_STATUSES,
  isTerminalStatus,
  type AgentStatus,
} from '../../shared/dashboard-protocol';
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
  /**
   * Configs de TODAS las invocaciones a startAgent, en orden de llegada.
   * El test de verification (Mecanismo A) hace que el bridge invoque
   * startAgent una vez por agente original + una vez por critic Haiku;
   * el array preserva ambas para que el test pueda emitir/finalizar a
   * cada una individualmente.
   */
  public readonly configs: AgentRunConfig[] = [];
  public readonly abortSignals: AbortSignal[] = [];
  /**
   * Resolvers FIFO. `finish()` sin index resuelve el más viejo no
   * resuelto (semántica preservada de la versión single-call: cuando
   * solo hay 1 startAgent en vuelo, FIFO == LIFO == el único).
   */
  private readonly resolvers: Array<(r: AgentResult) => void> = [];

  /** Backwards-compat con tests pre-verification: la última config recibida. */
  get lastConfig(): AgentRunConfig | undefined {
    return this.configs[this.configs.length - 1];
  }

  startAgent(config: AgentRunConfig): Promise<AgentResult> {
    this.configs.push(config);
    this.abortSignals.push(config.abortSignal);
    return new Promise<AgentResult>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  /** Emite un evento al startAgent más reciente. */
  emit(event: AgentEvent): void {
    const last = this.lastConfig;
    if (!last) throw new Error('startAgent no fue llamado todavía');
    last.onEvent(event);
  }

  /** Emite un evento a un startAgent específico por índice. */
  emitAt(index: number, event: AgentEvent): void {
    const cfg = this.configs[index];
    if (!cfg) throw new Error(`No hay config en index ${index}`);
    cfg.onEvent(event);
  }

  /** Resuelve el resolver FIFO (más viejo no resuelto). */
  finish(partial: Partial<AgentResult> = {}): void {
    const resolver = this.resolvers.shift();
    if (!resolver) throw new Error('No hay resolver activo');
    resolver(buildAgentResult(partial));
  }

  /** Resuelve un resolver por posición en el array (no muta el orden FIFO). */
  finishAt(index: number, partial: Partial<AgentResult> = {}): void {
    const resolver = this.resolvers[index];
    if (!resolver) throw new Error(`No hay resolver en index ${index}`);
    resolver(buildAgentResult(partial));
    // Marcamos consumed con un noop para mantener el shape del array
    // (los tests pueden seguir referenciando indices estables).
    this.resolvers[index] = () => {};
  }
}

function buildAgentResult(partial: Partial<AgentResult>): AgentResult {
  return {
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
 * emitUsage — fixture builder para AgentEvent type='usage_turn'. Centraliza
 * los campos cache que el bridge no inspecciona en estos tests para evitar
 * repetir el shape completo en cada caso.
 */
function emitUsage(runner: FakeAgentRunner, inputTokens: number, outputTokens: number): void {
  runner.emit({
    type: 'usage_turn',
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
}

// =====================================================================
// === runtimeToWireStatus =============================================
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

  it('predicate narrows el tipo al TerminalAgentStatus union', () => {
    // El narrowing TS: tras isTerminalStatus(s), `s` es del subtipo.
    // Esto se valida en compile-time por tsc, pero verificamos también
    // en runtime que el predicado no acepta strings random.
    expect(isTerminalStatus('unknown' as AgentStatus)).toBe(false);
  });
});

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
      type: 'usage_turn',
      inputTokens: 1,
      outputTokens: 8,
      cacheReadTokens: 105_583,
      cacheCreationTokens: 14_254,
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
    const filtered = bridge.getAgentLog(agentId, { since: tsCut })?.entries ?? [];
    expect(filtered).toHaveLength(1);
    expect(filtered[0].text).toBe('c');

    // since del último → array vacío.
    const tsLast = all[2].ts;
    expect(bridge.getAgentLog(agentId, { since: tsLast })?.entries).toEqual([]);

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

  // === wait_for_agents ===
  //
  // Test del long-poll del bridge. Diseño event-driven: cuando el
  // agente entra en estado terminal, onAgentCompleted dispara y el
  // wait resuelve. Para test reproducible con fake timers usamos
  // vi.useFakeTimers + advanceTimers.

  describe('waitForAgents', () => {
    it('retorna inmediato cuando todos los agentes ya terminaron', async () => {
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({
        prompt: 'hi',
        cwd: '/repos/myproj',
      });
      runner.emit({ type: 'text', text: 'final message' });
      runner.finish({ status: 'completed', durationMs: 2000 });
      await finished;

      const result = await bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 60_000,
        stuckThresholdMs: 60_000,
      });
      expect(result.timed_out).toBe(false);
      expect(result.pending).toEqual([]);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        agent_id: agentId,
        status: 'done',
        last_message: 'final message',
        duration_ms: 2000,
      });
    });

    it('agent_id desconocido retorna result con reason: not_found', async () => {
      const result = await bridge.waitForAgents({
        agentIds: ['ghost-uuid'],
        timeoutMs: 100,
        stuckThresholdMs: 60_000,
      });
      expect(result.timed_out).toBe(false);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        agent_id: 'ghost-uuid',
        status: 'failed',
        reason: 'not_found',
        last_message: null,
      });
    });

    it('captura last_message_partial mid-run para agentes pending', async () => {
      vi.useFakeTimers();
      bridge.attachWebview(webview as never);
      const { agentId } = bridge.spawn({
        prompt: 'long task',
        cwd: '/repos/myproj',
      });
      runner.emit({ type: 'text', text: 'progreso paso 1' });
      runner.emit({ type: 'text', text: 'progreso paso 2' });

      const waitPromise = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 100,
        stuckThresholdMs: 60_000,
      });
      // Avanzamos el timer del wait al timeout sin que el agente termine.
      await vi.advanceTimersByTimeAsync(150);
      const result = await waitPromise;

      expect(result.timed_out).toBe(true);
      expect(result.pending).toHaveLength(1);
      expect(result.pending[0]).toMatchObject({
        agent_id: agentId,
        status: 'running',
        last_message_partial: 'progreso paso 2',
        suspected_stuck: false,
      });
      expect(result.results).toEqual([]);

      vi.useRealTimers();
      runner.finish({ status: 'cancelled', durationMs: 1 });
    });

    it('marca suspected_stuck cuando el agente lleva > stuckThresholdMs sin actividad', async () => {
      vi.useFakeTimers();
      const baseTime = new Date('2026-05-26T20:00:00Z');
      vi.setSystemTime(baseTime);

      bridge.attachWebview(webview as never);
      const { agentId } = bridge.spawn({
        prompt: 'silent task',
        cwd: '/repos/myproj',
      });
      // Avanzamos 90s sin emitir ningún evento — el agente está en silencio.
      vi.setSystemTime(new Date(baseTime.getTime() + 90_000));

      const waitPromise = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 100,
        stuckThresholdMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(150);
      const result = await waitPromise;

      expect(result.pending).toHaveLength(1);
      expect(result.pending[0].suspected_stuck).toBe(true);

      vi.useRealTimers();
      runner.finish({ status: 'cancelled', durationMs: 1 });
    });

    it('resuelve sin timeout cuando el agente termina mid-wait', async () => {
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({
        prompt: 'task',
        cwd: '/repos/myproj',
      });

      // Disparamos el wait en paralelo; después emitimos finish.
      const waitPromise = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 60_000,
        stuckThresholdMs: 60_000,
      });
      runner.emit({ type: 'text', text: 'done!' });
      runner.finish({ status: 'completed', durationMs: 500 });
      await finished;

      const result = await waitPromise;
      expect(result.timed_out).toBe(false);
      expect(result.pending).toEqual([]);
      expect(result.results[0]).toMatchObject({
        agent_id: agentId,
        status: 'done',
        last_message: 'done!',
      });
    });

    it('cap defensivo dispara: reason=max_runtime_exceeded + timer limpiado', async () => {
      __setConfig('claudeOrchestrator', 'maxAgentRuntimeSec', 60);
      vi.useFakeTimers();

      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({
        prompt: 'long task',
        cwd: '/repos/myproj',
      });
      runner.emit({ type: 'text', text: 'progreso pre-cap' });

      // Avanzamos 60s — el cap-timer debería dispararse, llamar
      // bridge.cancel y setear reason='max_runtime_exceeded' antes
      // del bloque terminal.
      await vi.advanceTimersByTimeAsync(60_500);
      runner.finish({
        status: 'cancelled',
        finalResponse: 'User cancelled',
        durationMs: 60_000,
      });
      await finished;

      // El reason del cap NO fue pisado por el finalResponse del runner.
      const result = await bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 100,
        stuckThresholdMs: 60_000,
      });
      expect(result.results[0].reason).toBe('max_runtime_exceeded');
      expect(result.results[0].status).toBe('cancelled');

      vi.useRealTimers();
    });

    it('race cap-vs-cancel: si user cancela primero, el cap respeta su reason', async () => {
      __setConfig('claudeOrchestrator', 'maxAgentRuntimeSec', 60);
      vi.useFakeTimers();

      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({
        prompt: 'task',
        cwd: '/repos/myproj',
      });
      runner.emit({ type: 'text', text: 'midway' });

      // User setea reason manualmente (simula que algo seteó reason
      // antes del cap-timer). El cap-timer DEBE respetar y no pisarlo.
      const stored = bridge.listAgents().find((a) => a.id === agentId);
      expect(stored).toBeDefined();
      // Acceso vía la API pública: el cap-timer entra al callback con
      // un snapshot que ya tiene reason. Lo seteamos via cancel + log.
      // Como no hay setter público para reason, simulamos llamando
      // cancel y avanzando — el bloque terminal del run() setea reason
      // desde finalResponse, lo que activa el guard del cap.
      bridge.cancel(agentId);
      runner.finish({
        status: 'cancelled',
        finalResponse: 'User cancelled by hand',
        durationMs: 100,
      });
      await finished;

      // Ahora avanzamos al cap-timer. El callback debe encontrar reason
      // ya seteado y retornar sin pisar.
      await vi.advanceTimersByTimeAsync(60_500);

      const result = await bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 100,
        stuckThresholdMs: 60_000,
      });
      // reason vino del finalResponse del runner, NO de max_runtime_exceeded.
      expect(result.results[0].reason).toBe('User cancelled by hand');
      expect(result.results[0].reason).not.toBe('max_runtime_exceeded');

      vi.useRealTimers();
    });

    it('mix: un agente terminado + uno pending devuelve ambos correctamente', async () => {
      vi.useFakeTimers();
      bridge.attachWebview(webview as never);

      // Agente 1 — termina rápido.
      const r1 = bridge.spawn({ prompt: 'fast', cwd: '/repos/p1' });
      runner.emit({ type: 'text', text: 'agente1 final' });
      runner.finish({ status: 'completed', durationMs: 100 });
      await r1.finished;

      // Agente 2 — sigue corriendo durante el wait. Reusamos el mismo
      // runner; el FakeAgentRunner solo soporta un resolver a la vez.
      const r2 = bridge.spawn({ prompt: 'slow', cwd: '/repos/p2' });
      runner.emit({ type: 'text', text: 'agente2 procesando...' });

      const waitPromise = bridge.waitForAgents({
        agentIds: [r1.agentId, r2.agentId],
        timeoutMs: 100,
        stuckThresholdMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(150);
      const result = await waitPromise;

      expect(result.timed_out).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].agent_id).toBe(r1.agentId);
      expect(result.results[0].status).toBe('done');
      expect(result.pending).toHaveLength(1);
      expect(result.pending[0].agent_id).toBe(r2.agentId);
      expect(result.pending[0].last_message_partial).toBe('agente2 procesando...');

      vi.useRealTimers();
      runner.finish({ status: 'cancelled', durationMs: 1 });
    });

    // === Idempotency (subtarea A del ticket #0 v0.2) ===
    //
    // Una segunda call con el mismo set de agent_ids dentro del TTL del
    // waiter debe suscribirse al MISMO Promise — fan-in. Cubre el
    // escenario "transport drop + retry" documentado en el field report.

    it('idempotency: dos waitForAgents con mismos ids retornan el MISMO Promise (fan-in)', async () => {
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({
        prompt: 'task',
        cwd: '/repos/myproj',
      });

      const p1 = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 60_000,
        stuckThresholdMs: 60_000,
      });
      const p2 = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 60_000,
        stuckThresholdMs: 60_000,
      });
      // El fan-in real: misma referencia de Promise para ambos callers.
      // Sin esto, cada call habría creado su propio listener + timer y
      // duplicado el trabajo del long-poll.
      expect(p1).toBe(p2);

      runner.emit({ type: 'text', text: 'shared result' });
      runner.finish({ status: 'completed', durationMs: 500 });
      await finished;
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe(r2);
      expect(r1.results[0].last_message).toBe('shared result');
    });

    it('idempotency: orden distinto de agent_ids comparte el mismo waiter (key estable)', async () => {
      bridge.attachWebview(webview as never);
      // FakeAgentRunner solo soporta UN resolver vivo a la vez. Cerramos
      // el primero antes de spawnear el segundo para no perder al primer
      // resolver — el wait usa AMBOS ids pero el agente A ya está done
      // (cheap-path para A) y B sigue running (long-poll real).
      const a = bridge.spawn({ prompt: 'a', cwd: '/repos/p1' });
      runner.finish({ status: 'completed', durationMs: 100 });
      await a.finished;

      const b = bridge.spawn({ prompt: 'b', cwd: '/repos/p2' });

      const p1 = bridge.waitForAgents({
        agentIds: [a.agentId, b.agentId],
        timeoutMs: 60_000,
        stuckThresholdMs: 60_000,
      });
      const p2 = bridge.waitForAgents({
        // Orden invertido — el chat caller puede mandar los ids en
        // cualquier orden tras un drop. La key del waiter lo normaliza.
        agentIds: [b.agentId, a.agentId],
        timeoutMs: 60_000,
        stuckThresholdMs: 60_000,
      });
      expect(p1).toBe(p2);

      runner.finish({ status: 'completed', durationMs: 100 });
      await b.finished;
      await Promise.all([p1, p2]);
    });

    it('idempotency: segundo caller con timeoutMs distinto recibe el promise existente — su timeout es IGNORADO', async () => {
      // Contrato documentado en server.ts + tool description: el waiter
      // compartido usa los params del PRIMER call. Verificamos que un
      // retry con timeoutMs corto no acelera la resolución.
      vi.useFakeTimers();
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({
        prompt: 'long',
        cwd: '/repos/myproj',
      });

      const p1 = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      // Segundo caller pide timeoutMs corto (1s). Si el fan-in honrara el
      // segundo timeout, p2 resolvería en 1s con timed_out=true. Como
      // honra el del primero, ambos resuelven en t=5s.
      const p2 = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 1_000,
        stuckThresholdMs: 60_000,
      });
      expect(p1).toBe(p2);

      // Avanzamos 2s — segundo timeout habría disparado, pero compartido NO.
      await vi.advanceTimersByTimeAsync(2_000);
      // Avanzamos hasta el primer timeout.
      await vi.advanceTimersByTimeAsync(4_000);
      const r1 = await p1;
      expect(r1.timed_out).toBe(true);
      expect(r1.pending).toHaveLength(1);

      vi.useRealTimers();
      runner.finish({ status: 'cancelled', durationMs: 1 });
      await finished;
    });

    it('idempotency: TTL expirado en cache descarta el entry viejo y crea waiter nuevo', async () => {
      // El cache tiene TTL de 30 min. Una segunda call DESPUÉS del TTL
      // tiene que crear un waiter fresh aunque el agentId sea el mismo.
      vi.useFakeTimers();
      const baseTime = new Date('2026-05-28T10:00:00Z').getTime();
      vi.setSystemTime(baseTime);

      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({
        prompt: 'long',
        cwd: '/repos/myproj',
      });
      const p1 = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 60_000,
        stuckThresholdMs: 60_000,
      });

      // Saltamos > 30 min y forzamos resolución del primer waiter.
      vi.setSystemTime(baseTime + 31 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(60_000);
      await p1;

      const p2 = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 60_000,
        stuckThresholdMs: 60_000,
      });
      // p2 NO debe ser p1: el cache miró que el entry estaba expirado
      // (createdAt + TTL < now) y descartó antes de buscar fan-in.
      expect(p2).not.toBe(p1);
      vi.useRealTimers();
      runner.finish({ status: 'cancelled', durationMs: 1 });
      await finished;
    });

    it('idempotency: tras resolver el waiter, una call siguiente NO reusa la promise cacheada', async () => {
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({
        prompt: 'task',
        cwd: '/repos/myproj',
      });

      const p1 = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 60_000,
        stuckThresholdMs: 60_000,
      });
      runner.finish({ status: 'completed', durationMs: 200 });
      await finished;
      await p1;

      // Damos un microtask al .finally() del bridge para que limpie el cache.
      await Promise.resolve();
      // Segunda call cae al cheap-path (agente terminado) y vuelve
      // resultado fresco — no debe ser la misma Promise resuelta.
      const p2 = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 60_000,
        stuckThresholdMs: 60_000,
      });
      expect(p2).not.toBe(p1);
      const r2 = await p2;
      expect(r2.results[0].status).toBe('done');
    });
  });

  // =====================================================================
  // === transportState (subtarea D del ticket #0 v0.2) ==================
  // =====================================================================
  //
  // Heurística: si un wait_for_agents lleva >60s sin resolver, marcamos
  // `transportState='degraded'`. Cuando resuelve, vuelve a `'healthy'`.
  // Una transición emite `transport_state_changed` al webview.

  describe('transportState', () => {
    it('arranca healthy y emite el estado al attach (replay)', () => {
      bridge.attachWebview(webview as never);
      expect(bridge.getTransportState()).toBe('healthy');
      const transports = postedOf(webview, 'transport_state_changed');
      expect(transports).toHaveLength(1);
      expect(transports[0].state).toBe('healthy');
    });

    it('transiciona a degraded a los 60s con un waiter activo y emite el evento UNA vez', async () => {
      vi.useFakeTimers();
      bridge.attachWebview(webview as never);
      const { agentId } = bridge.spawn({ prompt: 'slow', cwd: '/repos/p' });

      const waitPromise = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 120_000,
        stuckThresholdMs: 60_000,
      });
      expect(bridge.getTransportState()).toBe('healthy');

      // Avanzamos 65s — pasa el threshold de TRANSPORT_DEGRADED (60s).
      await vi.advanceTimersByTimeAsync(65_000);
      expect(bridge.getTransportState()).toBe('degraded');

      // El bridge ya emitió un transport_state_changed inicial al
      // attach (healthy). Esperamos otro con state='degraded'.
      const transports = postedOf(webview, 'transport_state_changed');
      const degraded = transports.filter((t) => t.state === 'degraded');
      expect(degraded).toHaveLength(1);

      // Resolvemos el waiter y verificamos vuelta a healthy.
      await vi.advanceTimersByTimeAsync(60_000);
      runner.finish({ status: 'cancelled', durationMs: 1 });
      await waitPromise;
      // El .finally() del waiter limpia el degradedWaiter set; el
      // updateTransportState emite el healthy.
      expect(bridge.getTransportState()).toBe('healthy');
      const healthy = postedOf(webview, 'transport_state_changed').filter(
        (t) => t.state === 'healthy',
      );
      // 1 del attach inicial + 1 de la transición desde degraded.
      expect(healthy).toHaveLength(2);

      vi.useRealTimers();
    });

    it('no transiciona si el waiter resuelve antes del threshold', async () => {
      vi.useFakeTimers();
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({
        prompt: 'fast',
        cwd: '/repos/p',
      });

      const waitPromise = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 120_000,
        stuckThresholdMs: 60_000,
      });
      // Resolvemos a los 10s — bien antes del threshold de 60s.
      await vi.advanceTimersByTimeAsync(10_000);
      runner.finish({ status: 'completed', durationMs: 10_000 });
      await finished;
      await waitPromise;

      expect(bridge.getTransportState()).toBe('healthy');
      const degraded = postedOf(webview, 'transport_state_changed').filter(
        (t) => t.state === 'degraded',
      );
      expect(degraded).toHaveLength(0);

      vi.useRealTimers();
    });
  });

  // =====================================================================
  // === usage_final NO toca contextTokens (subtarea F del ticket #0) ====
  // =====================================================================

  describe('usage_final separation', () => {
    it('usage_final actualiza costUsd pero deja contextTokens del último usage_turn', () => {
      bridge.attachWebview(webview as never);
      bridge.spawn({ prompt: 'task', cwd: '/repos/p' });

      // Turn 1: agente reporta 110k context activo (representativo de un
      // turno mid-run con bastante cache).
      runner.emit({
        type: 'usage_turn',
        inputTokens: 100,
        outputTokens: 500,
        cacheReadTokens: 105_000,
        cacheCreationTokens: 4_900,
      });

      // Cierre: el SDK emite el result con cumulativos cross-turn — los
      // cacheRead+cacheCreation del result son la suma de TODOS los
      // turnos (puede ser >> 200k). El bug histórico: el bridge pisaba
      // contextTokens con esos cumulativos → ContextBar mostraba 10M+.
      runner.emit({
        type: 'usage_final',
        inputTokens: 200,
        outputTokens: 800,
        cacheReadTokens: 10_500_000,
        cacheCreationTokens: 400_000,
        costUsd: 0.87,
      });

      const changes = postedOf(webview, 'agent_status_changed');
      const last = changes[changes.length - 1];
      // contextTokens debe seguir siendo el del último usage_turn
      // (100 + 105000 + 4900 = 109_900). NO el cumulative del final.
      const allWithContext = changes.filter(
        (c) => c.metadata?.contextTokens !== undefined,
      );
      const lastContext = allWithContext[allWithContext.length - 1];
      // 100 + 105_000 + 4_900 = 110_000 (último usage_turn, NO el final).
      expect(lastContext.metadata?.contextTokens).toBe(110_000);
      // contextUsedPct = 110_000 / 200_000 = 55%.
      expect(lastContext.metadata?.contextUsedPct).toBe(55);
      // costUsd sí se actualiza con el cumulative real del SDK.
      expect(last.metadata?.costUsd).toBe(0.87);
      // Cerramos el run para que dispose() no espere indefinidamente.
      runner.finish({ status: 'completed', durationMs: 1 });
    });

    it('usage_final POBLA tokensUsed con cumulative cross-turn (regresión guard)', async () => {
      // Bug histórico: el bridge se quedaba con `lastTokensUsed` del
      // último `usage_turn` (per-turn delta, ~5k) y reportaba eso en
      // RECENT cards + toast en lugar del cumulative real (~150k para
      // 30 turnos). El terminal block `lastTokensUsed || result.input+
      // output` no caía al fallback porque lastTokensUsed era truthy.
      bridge.attachWebview(webview as never);
      const { finished } = bridge.spawn({ prompt: 'task', cwd: '/repos/p' });
      runner.emit({
        type: 'usage_turn',
        inputTokens: 100,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      runner.emit({
        type: 'usage_turn',
        inputTokens: 200,
        outputTokens: 800,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      // Cumulative real al cierre del SDK (suma de los 2 turnos = 1600).
      runner.emit({
        type: 'usage_final',
        inputTokens: 300,
        outputTokens: 1300,
        cacheReadTokens: 50_000,
        cacheCreationTokens: 5_000,
        costUsd: 0.05,
      });
      runner.finish({
        status: 'completed',
        durationMs: 2000,
        inputTokens: 300,
        outputTokens: 1300,
      });
      await finished;
      const completed = postedOf(webview, 'agent_completed');
      // Bug regression: si el handler ignorara usage_final, tokensUsed
      // mostraría el último turn delta (200+800=1000), NO el cumulative.
      expect(completed[0].result.tokensUsed).toBe(1600);
    });

    it('usage_final POBLA contextTokens fallback cuando no hubo usage_turn (error-only run)', () => {
      // Edge case: runs error-only o cached-only sin assistant message
      // nunca disparan `usage_turn` (agent-runner los gate con
      // inputTokens>0 || outputTokens>0). Sin fallback, ContextBar
      // mostraría 0% para agentes que sí consumieron 50k+ via cache.
      bridge.attachWebview(webview as never);
      bridge.spawn({ prompt: 'fail', cwd: '/repos/p' });
      // Solo usage_final, sin usage_turn previo.
      runner.emit({
        type: 'usage_final',
        inputTokens: 200,
        outputTokens: 0,
        cacheReadTokens: 60_000,
        cacheCreationTokens: 5_000,
        costUsd: 0.001,
      });
      const changes = postedOf(webview, 'agent_status_changed');
      const last = changes[changes.length - 1];
      // 200 + 60_000 + 5_000 = 65_200 (fallback al cumulative del final).
      expect(last.metadata?.contextTokens).toBe(65_200);
      expect(last.metadata?.contextUsedPct).toBe(33);
      runner.finish({ status: 'completed', durationMs: 1 });
    });
  });

  // =====================================================================
  // === getAgentLog filtros (subtarea E del ticket #0) ==================
  // =====================================================================

  describe('getAgentLog opts', () => {
    it('tail_lines retorna solo los últimos N entries', () => {
      bridge.attachWebview(webview as never);
      const { agentId } = bridge.spawn({ prompt: 'x', cwd: '/repos/p' });
      for (let i = 0; i < 10; i++) {
        runner.emit({ type: 'text', text: `entry ${i}` });
      }
      const res = bridge.getAgentLog(agentId, { tailLines: 3 });
      expect(res?.entries).toHaveLength(3);
      expect((res?.entries[0] as { text: string }).text).toBe('entry 7');
      expect((res?.entries[2] as { text: string }).text).toBe('entry 9');
      runner.finish({ status: 'cancelled', durationMs: 1 });
    });

    it('kinds_filter filtra por kind antes del tail', () => {
      bridge.attachWebview(webview as never);
      const { agentId } = bridge.spawn({ prompt: 'x', cwd: '/repos/p' });
      runner.emit({ type: 'text', text: 'reply 1' });
      runner.emit({ type: 'tool_use', name: 'Read', input: { file: 'a' } });
      runner.emit({
        type: 'tool_result',
        toolUseId: 't1',
        result: 'ok',
        isError: false,
      });
      runner.emit({ type: 'text', text: 'reply 2' });
      runner.emit({ type: 'thinking', text: 'thinking aloud' });

      const res = bridge.getAgentLog(agentId, { kindsFilter: ['text'] });
      expect(res?.entries.map((e) => e.kind)).toEqual(['text', 'text']);
      expect((res?.entries[1] as { text: string }).text).toBe('reply 2');
      runner.finish({ status: 'cancelled', durationMs: 1 });
    });

    it('kinds_filter + tail_lines combinados: filtra y después tail', () => {
      bridge.attachWebview(webview as never);
      const { agentId } = bridge.spawn({ prompt: 'x', cwd: '/repos/p' });
      runner.emit({ type: 'text', text: 'r1' });
      runner.emit({ type: 'tool_use', name: 'Read', input: {} });
      runner.emit({ type: 'text', text: 'r2' });
      runner.emit({ type: 'text', text: 'r3' });
      runner.emit({ type: 'thinking', text: 'noise' });

      const res = bridge.getAgentLog(agentId, {
        kindsFilter: ['text'],
        tailLines: 2,
      });
      // 3 text entries → tail 2 → ['r2', 'r3'].
      expect(res?.entries).toHaveLength(2);
      expect((res?.entries[0] as { text: string }).text).toBe('r2');
      expect((res?.entries[1] as { text: string }).text).toBe('r3');
      runner.finish({ status: 'cancelled', durationMs: 1 });
    });

    it('default (sin opts) devuelve el ringbuffer completo — legacy compat', () => {
      bridge.attachWebview(webview as never);
      const { agentId } = bridge.spawn({ prompt: 'x', cwd: '/repos/p' });
      runner.emit({ type: 'text', text: 'a' });
      runner.emit({ type: 'tool_use', name: 'Read', input: {} });
      runner.emit({ type: 'thinking', text: 'b' });

      const res = bridge.getAgentLog(agentId);
      expect(res?.entries).toHaveLength(3);
      runner.finish({ status: 'cancelled', durationMs: 1 });
    });
  });

  // ==========================================================================
  // === git helpers (readGitHead + captureCriticDiff) =======================
  // ==========================================================================
  //
  // Cubren la captura del HEAD al spawn + el diff que recibe el critic.
  // El bug que motivó el test del diff: usar `<headBefore>..HEAD` deja el
  // diff vacío porque el agente NO commitea sus cambios, así que HEAD no
  // se mueve. `git diff <headBefore>` (sin `..HEAD`) compara working tree
  // vs commit y captura los cambios reales del agente.

  describe('readGitHead', () => {
    it('retorna el SHA cuando git rev-parse responde con un commit', () => {
      const spy = vi
        .mocked(childProcess.execFileSync)
        .mockReturnValueOnce('abc123def\n' as never);
      const sha = readGitHead('/repos/p');
      expect(sha).toBe('abc123def');
      expect(spy).toHaveBeenCalledWith(
        'git',
        ['-C', '/repos/p', 'rev-parse', 'HEAD'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('retorna undefined cuando git falla (cwd no es repo)', () => {
      vi.mocked(childProcess.execFileSync).mockImplementationOnce(() => {
        throw new Error('not a git repo');
      });
      expect(readGitHead('/repos/p')).toBeUndefined();
    });

    it('retorna undefined cuando git devuelve vacío (repo sin commits)', () => {
      vi.mocked(childProcess.execFileSync).mockReturnValueOnce('\n' as never);
      expect(readGitHead('/repos/p')).toBeUndefined();
    });
  });

  describe('captureCriticDiff', () => {
    /**
     * Helper para mockear `execFile` async retornando stdout específico
     * UN call. El mock del módulo es callback-based (firma util.promisify);
     * implementOnce invoca el cb con (err, stdout, stderr).
     */
    function mockExecFileOnce(
      stdout: string,
      err: Error | null = null,
    ): void {
      vi.mocked(childProcess.execFile).mockImplementationOnce(
        ((
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (e: Error | null, out: string, e2: string) => void,
        ) => {
          cb(err, stdout, '');
          return {} as never;
        }) as never,
      );
    }

    it('headBefore undefined → diff vacío sin invocar git', async () => {
      const spy = vi.mocked(childProcess.execFile);
      spy.mockClear();
      const result = await captureCriticDiff('/repos/p', undefined);
      expect(result).toEqual({ diff: '', truncated: false });
      expect(spy).not.toHaveBeenCalled();
    });

    it('compara working tree vs commit con `git diff <headBefore>` (NO `..HEAD`)', async () => {
      // Bug regression guard: el agente modifica archivos sin commitear,
      // así que HEAD no se mueve entre spawn y close. Si usáramos
      // `<headBefore>..HEAD` (entre dos commits), el diff sería SIEMPRE
      // vacío y el critic no vería los cambios reales. Validamos que
      // los args del execFile NO incluyan `..HEAD`.
      const expectedDiff = 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n';
      const spy = vi.mocked(childProcess.execFile);
      spy.mockClear();
      mockExecFileOnce(expectedDiff);
      const result = await captureCriticDiff('/repos/p', 'cabf15d');
      expect(result).toEqual({ diff: expectedDiff, truncated: false });
      const callArgs = spy.mock.calls[spy.mock.calls.length - 1];
      expect(callArgs[0]).toBe('git');
      expect(callArgs[1]).toEqual(['-C', '/repos/p', 'diff', 'cabf15d']);
      const gitArgs = callArgs[1] as string[];
      expect(gitArgs.some((a) => a.includes('..'))).toBe(false);
    });

    it('git diff falla → retorna diff vacío sin tirar', async () => {
      mockExecFileOnce('', new Error('git diff exploded'));
      const result = await captureCriticDiff('/repos/p', 'abc123');
      expect(result).toEqual({ diff: '', truncated: false });
    });

    it('output >500 KB se trunca a 500 KB con flag truncated=true', async () => {
      const huge = 'x'.repeat(600 * 1024);
      mockExecFileOnce(huge);
      const result = await captureCriticDiff('/repos/p', 'abc123');
      expect(result.diff.length).toBe(500 * 1024);
      expect(result.truncated).toBe(true);
    });

    it('output exactamente 500 KB NO se trunca', async () => {
      const exact = 'x'.repeat(500 * 1024);
      mockExecFileOnce(exact);
      const result = await captureCriticDiff('/repos/p', 'abc123');
      expect(result.diff.length).toBe(500 * 1024);
      expect(result.truncated).toBe(false);
    });
  });

  // ==========================================================================
  // === verification (Mecanismo D + A) ======================================
  // ==========================================================================

  describe('verification (Mecanismo D + A)', () => {
    /**
     * Helper: emite un text con un JSON block conforme a EXIT_SCHEMA_V1.
     * Centraliza la fixture para que los tests describan QUÉ del shape
     * importa (decisions vs uncertainties vs status) sin repetir el
     * bloque JSON entero.
     */
    function emitExitReport(
      run: FakeAgentRunner,
      shape: {
        status?: 'ok' | 'needs_review' | 'failed';
        files_changed?: string[];
        evidence_run?: string[];
        decisions_made_without_consultation?: string[];
        uncertainties?: string[];
      },
    ): void {
      const payload = {
        status: shape.status ?? 'ok',
        files_changed: shape.files_changed ?? [],
        evidence_run: shape.evidence_run ?? [],
        decisions_made_without_consultation:
          shape.decisions_made_without_consultation ?? [],
        uncertainties: shape.uncertainties ?? [],
      };
      run.emit({
        type: 'text',
        text: `Listo.\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
      });
    }

    /**
     * Helper: emite un text con la salida JSON del critic Haiku.
     * El bridge espera flags + summary (parseCriticOutput).
     */
    function emitCriticOutput(
      run: FakeAgentRunner,
      flags: Array<{ severity: 'high' | 'med' | 'low'; summary: string }>,
    ): void {
      const payload = { flags, summary: flags.length === 0 ? 'no concerns' : `${flags.length} findings` };
      run.emit({
        type: 'text',
        text: `Revisado.\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
      });
    }

    it('mode=none: legacy — no inyecta exit instruction, no parsea, no spawnea critic', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'none');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'do X', cwd: '/repos/p' });
      // El prompt que recibió el runner NO debe incluir el bloque exit-schema.
      expect(runner.lastConfig?.prompt).toBe('do X');
      // El agente devuelve texto con JSON pero el bridge no debe parsear.
      emitExitReport(runner, {
        status: 'ok',
        decisions_made_without_consultation: ['flipped X'],
      });
      runner.finish({ status: 'completed', durationMs: 100, finalResponse: 'done' });
      await finished;

      const result = await bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      // Una sola startAgent invocada — sin critic spawn.
      expect(runner.configs).toHaveLength(1);
      expect(result.results[0].status).toBe('done');
      expect(result.results[0].verification).toBeUndefined();
    });

    it('mode=structured: inyecta exit instruction y parsea (sin critic)', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'structured');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'do X', cwd: '/repos/p' });
      // El prompt que llegó al runner debe contener el briefing exit-schema.
      expect(runner.lastConfig?.prompt).toContain('Exit report (mandatory)');
      expect(runner.lastConfig?.prompt).toContain('do X');

      emitExitReport(runner, {
        status: 'ok',
        files_changed: ['a.py'],
        evidence_run: ['ast.parse OK'],
      });
      runner.finish({ status: 'completed', durationMs: 100 });
      await finished;

      const result = await bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      // Sin critic spawn — solo una startAgent.
      expect(runner.configs).toHaveLength(1);
      expect(result.results[0].status).toBe('done');
      expect(result.results[0].verification).toBeDefined();
      expect(result.results[0].verification?.mode).toBe('structured');
      expect(result.results[0].verification?.exit_report).toMatchObject({
        status: 'ok',
        files_changed: ['a.py'],
        evidence_run: ['ast.parse OK'],
      });
    });

    it('mode=structured + decisions no vacíos → auto-promote a needs_review (reason=decisions)', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'structured');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'add a test', cwd: '/repos/p' });
      emitExitReport(runner, {
        status: 'ok',
        decisions_made_without_consultation: [
          'Replaced existing test instead of adding new one',
        ],
      });
      runner.finish({ status: 'completed', durationMs: 100 });
      await finished;

      const result = await bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      expect(result.results[0].status).toBe('needs_review');
      expect(result.results[0].verification?.auto_promoted_reason).toBe('decisions');
    });

    it('mode=structured + uncertainties no vacías → auto-promote (reason=uncertainties)', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'structured');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'port to v19', cwd: '/repos/p' });
      emitExitReport(runner, {
        status: 'ok',
        uncertainties: ['display_name may not exist in v19'],
      });
      runner.finish({ status: 'completed', durationMs: 100 });
      await finished;

      const result = await bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      expect(result.results[0].status).toBe('needs_review');
      expect(result.results[0].verification?.auto_promoted_reason).toBe('uncertainties');
    });

    it('mode=structured + exit malformado → status legacy + exit_parse_reason en wire', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'structured');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'do X', cwd: '/repos/p' });
      // Agente legacy / desobediente: sin JSON al final.
      runner.emit({ type: 'text', text: 'Solo prosa, sin reporte.' });
      runner.finish({ status: 'completed', durationMs: 100 });
      await finished;

      const result = await bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      // Status queda como 'done' (backwards-compat con agentes legacy).
      expect(result.results[0].status).toBe('done');
      expect(result.results[0].verification?.exit_parse_reason).toBe('no_json_block');
      expect(result.results[0].verification?.exit_report).toBeUndefined();
    });

    it('mode=critic: NO inyecta exit instruction, sí spawnea critic Haiku', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'critic');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'do X', cwd: '/repos/p' });
      // Sin exit-schema en el prompt.
      expect(runner.lastConfig?.prompt).toBe('do X');
      runner.emit({ type: 'text', text: 'Cambié algo.' });
      runner.finish({ status: 'completed', durationMs: 100 });
      await finished;

      const waitPromise = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      // Esperamos a que el bridge invoque startAgent para el critic.
      await vi.waitFor(() => expect(runner.configs).toHaveLength(2));
      // El critic debe llamarse con model='haiku' + tools allow-list.
      const criticCfg = runner.configs[1];
      expect(criticCfg.model).toBe('haiku');
      expect(criticCfg.tools).toEqual(['Read', 'Bash', 'Grep', 'Glob']);
      expect(criticCfg.tools).not.toContain('Write');
      expect(criticCfg.tools).not.toContain('Edit');
      // Critic devuelve "no concerns".
      emitCriticOutput(runner, []);
      runner.finish({ status: 'completed', durationMs: 50, finalResponse: '```json\n{"flags":[],"summary":"no concerns"}\n```', costUsd: 0.002 });

      const result = await waitPromise;
      expect(result.results[0].status).toBe('done');
      expect(result.results[0].verification?.mode).toBe('critic');
      expect(result.results[0].verification?.critic_findings).toEqual([]);
      expect(result.results[0].verification?.critic_cost_usd).toBeCloseTo(0.002);
    });

    it('mode=both: critic encuentra flag → promueve a needs_review (reason=critic_flags)', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'both');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'fix test', cwd: '/repos/p' });
      // Agente honesto sin decisions; reporta OK.
      emitExitReport(runner, { status: 'ok' });
      runner.finish({ status: 'completed', durationMs: 100, finalResponse: '```json\n{"status":"ok","files_changed":[],"evidence_run":[],"decisions_made_without_consultation":[],"uncertainties":[]}\n```' });
      await finished;

      const waitPromise = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      await vi.waitFor(() => expect(runner.configs).toHaveLength(2));
      emitCriticOutput(runner, [
        { severity: 'high', summary: 'assertion flipped without justification' },
      ]);
      runner.finish({
        status: 'completed',
        durationMs: 50,
        finalResponse:
          '```json\n{"flags":[{"severity":"high","summary":"assertion flipped without justification"}],"summary":"1 high"}\n```',
      });

      const result = await waitPromise;
      expect(result.results[0].status).toBe('needs_review');
      expect(result.results[0].verification?.auto_promoted_reason).toBe('critic_flags');
      expect(result.results[0].verification?.critic_findings).toHaveLength(1);
      expect(result.results[0].verification?.critic_findings?.[0].severity).toBe('high');
    });

    it('mode=both + D y A ambos disparan → autoPromoteReason agrega critic_flags', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'both');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'big change', cwd: '/repos/p' });
      // Agente declara decisions (D auto-promueve).
      emitExitReport(runner, {
        status: 'ok',
        decisions_made_without_consultation: ['renamed foo()'],
      });
      runner.finish({
        status: 'completed',
        durationMs: 100,
        finalResponse:
          '```json\n{"status":"ok","decisions_made_without_consultation":["renamed foo()"],"uncertainties":[]}\n```',
      });
      await finished;

      const waitPromise = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      await vi.waitFor(() => expect(runner.configs).toHaveLength(2));
      emitCriticOutput(runner, [
        { severity: 'med', summary: 'callers not updated' },
      ]);
      runner.finish({
        status: 'completed',
        durationMs: 50,
        finalResponse:
          '```json\n{"flags":[{"severity":"med","summary":"callers not updated"}],"summary":"1 med"}\n```',
      });

      const result = await waitPromise;
      expect(result.results[0].status).toBe('needs_review');
      // El reason debe incluir AMBOS: 'decisions' + 'critic_flags' por D-first.
      expect(result.results[0].verification?.auto_promoted_reason).toContain('decisions');
      expect(result.results[0].verification?.auto_promoted_reason).toContain('critic_flags');
    });

    it('mode=both: critic NO se vuelve a correr en una segunda waitForAgents (idempotency per-agente)', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'both');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'task', cwd: '/repos/p' });
      emitExitReport(runner, { status: 'ok' });
      runner.finish({
        status: 'completed',
        durationMs: 100,
        finalResponse:
          '```json\n{"status":"ok","decisions_made_without_consultation":[],"uncertainties":[]}\n```',
      });
      await finished;

      const wait1 = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      await vi.waitFor(() => expect(runner.configs).toHaveLength(2));
      emitCriticOutput(runner, []);
      runner.finish({
        status: 'completed',
        durationMs: 50,
        finalResponse: '```json\n{"flags":[],"summary":"no concerns"}\n```',
      });
      await wait1;

      // Segunda llamada con DIFERENTE key (no fan-in cache) — para
      // forzar que runWait corra de nuevo. Verificamos que NO se
      // dispare un segundo critic spawn.
      const wait2 = bridge.waitForAgents({
        agentIds: [agentId, 'other-id'],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      await wait2;
      // Sigue habiendo solo 2 startAgent calls (original + 1 critic).
      // No se spawneó un segundo critic para el mismo agentId.
      expect(runner.configs).toHaveLength(2);
    });

    it('mode locked at spawn: cambiar setting mid-flight NO afecta agentes ya corriendo', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'structured');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'A', cwd: '/repos/p' });
      // Cambiamos el setting MID-FLIGHT.
      __setConfig('claudeOrchestrator', 'verification', 'none');
      emitExitReport(runner, {
        status: 'ok',
        uncertainties: ['x'],
      });
      runner.finish({ status: 'completed', durationMs: 100 });
      await finished;

      const result = await bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      // El agente arrancó con 'structured' — el lock al spawn fuerza
      // la promoción aunque el setting actual sea 'none'.
      expect(result.results[0].status).toBe('needs_review');
      expect(result.results[0].verification?.mode).toBe('structured');
    });

    it('mode inválido en el setting (ej. "off") cae al default "structured"', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'off-not-an-enum');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'A', cwd: '/repos/p' });
      // El prompt debe llevar el briefing de exit-schema (porque cayó a 'structured').
      expect(runner.lastConfig?.prompt).toContain('Exit report (mandatory)');
      runner.finish({ status: 'completed', durationMs: 100 });
      await finished;

      const result = await bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      expect(result.results[0].verification?.mode).toBe('structured');
    });

    it('promoción dispara agent_status_changed con status=needs_review al webview', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'structured');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'A', cwd: '/repos/p' });
      emitExitReport(runner, {
        status: 'ok',
        decisions_made_without_consultation: ['unauthorized rename'],
      });
      runner.finish({ status: 'completed', durationMs: 100 });
      await finished;

      // El status_changed post-D promotion debería verse en los messages
      // posteados al webview.
      await bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      const promotions = postedOf(webview, 'agent_status_changed').filter(
        (e) => e.agentId === agentId && e.status === 'needs_review',
      );
      expect(promotions.length).toBeGreaterThanOrEqual(1);
    });

    it('snapshot del agente trae verificationMode al spawn cuando setting ≠ none', () => {
      __setConfig('claudeOrchestrator', 'verification', 'both');
      bridge.attachWebview(webview as never);
      bridge.spawn({ prompt: 'task', cwd: '/repos/p' });
      const created = postedOf(webview, 'agent_created');
      expect(created).toHaveLength(1);
      expect(created[0].agent.verificationMode).toBe('both');
      // reviewed/promoted arrancan undefined (no se setean en spawn).
      expect(created[0].agent.verificationReviewed).toBeUndefined();
      expect(created[0].agent.verificationPromoted).toBeUndefined();
      runner.finish({ status: 'cancelled', durationMs: 1 });
    });

    it('snapshot del agente NO trae verificationMode cuando setting = none (legacy compat)', () => {
      __setConfig('claudeOrchestrator', 'verification', 'none');
      bridge.attachWebview(webview as never);
      bridge.spawn({ prompt: 'task', cwd: '/repos/p' });
      const created = postedOf(webview, 'agent_created');
      expect(created[0].agent.verificationMode).toBeUndefined();
      runner.finish({ status: 'cancelled', durationMs: 1 });
    });

    it('verificationReviewed=true se emite vía agent_status_changed al cierre del wait_for_agents', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'structured');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'task', cwd: '/repos/p' });
      emitExitReport(runner, { status: 'ok' });
      runner.finish({ status: 'completed', durationMs: 100 });
      await finished;

      await bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      // Buscamos el agent_status_changed con verificationReviewed=true.
      const reviewedEvents = postedOf(webview, 'agent_status_changed').filter(
        (e) => e.agentId === agentId && e.metadata?.verificationReviewed === true,
      );
      expect(reviewedEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('verificationPromoted=true se emite junto con la promoción a needs_review', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'structured');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'task', cwd: '/repos/p' });
      emitExitReport(runner, {
        status: 'ok',
        decisions_made_without_consultation: ['unauthorized rename'],
      });
      runner.finish({ status: 'completed', durationMs: 100 });
      await finished;

      await bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      // El evento de promoción debe traer verificationPromoted=true en metadata.
      const promoted = postedOf(webview, 'agent_status_changed').filter(
        (e) =>
          e.agentId === agentId &&
          e.status === 'needs_review' &&
          e.metadata?.verificationPromoted === true,
      );
      expect(promoted.length).toBeGreaterThanOrEqual(1);
    });

    it('listAgents devuelve snapshots con verificationMode/Reviewed/Promoted poblados post-wait', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'structured');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'task', cwd: '/repos/p' });
      emitExitReport(runner, {
        status: 'ok',
        uncertainties: ['display_name v19?'],
      });
      runner.finish({ status: 'completed', durationMs: 100 });
      await finished;

      await bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      const list = bridge.listAgents();
      const agent = list.find((a) => a.id === agentId);
      expect(agent).toBeDefined();
      expect(agent?.verificationMode).toBe('structured');
      expect(agent?.verificationReviewed).toBe(true);
      expect(agent?.verificationPromoted).toBe(true);
      expect(agent?.status).toBe('needs_review');
    });

    it('critic timeout 90s → flag artificial "critic_timeout" visible pero NO promueve (synthetic low)', async () => {
      vi.useFakeTimers();
      __setConfig('claudeOrchestrator', 'verification', 'critic');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'A', cwd: '/repos/p' });
      runner.emit({ type: 'text', text: 'cambié algo.' });
      runner.finish({ status: 'completed', durationMs: 100 });
      await finished;

      const waitPromise = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 200_000,
        stuckThresholdMs: 60_000,
      });
      // Esperamos a que el bridge invoque al critic.
      await vi.waitFor(() => expect(runner.configs).toHaveLength(2));
      // Avanzamos 91s: el critic timeout (90s) debe disparar el abort.
      await vi.advanceTimersByTimeAsync(91_000);
      // Inmediatamente terminamos el critic (como abortado).
      runner.finish({ status: 'cancelled', durationMs: 91_000, finalResponse: null });

      const result = await waitPromise;
      vi.useRealTimers();
      // El flag artificial queda visible en critic_findings para
      // diagnóstico, pero NO promueve porque es synthetic low-severity
      // (indica "verification couldn't analyze", no "agent did wrong").
      expect(result.results[0].verification?.critic_findings).toHaveLength(1);
      expect(result.results[0].verification?.critic_findings?.[0].summary).toBe('critic_timeout');
      expect(result.results[0].verification?.critic_findings?.[0].severity).toBe('low');
      expect(result.results[0].status).toBe('done');
      expect(result.results[0].verification?.auto_promoted_reason).toBeUndefined();
    });

    it('synthetic low-severity flags (schema-violation, no-output, malformed JSON) NO promueven', async () => {
      __setConfig('claudeOrchestrator', 'verification', 'critic');
      bridge.attachWebview(webview as never);
      const { agentId, finished } = bridge.spawn({ prompt: 'task', cwd: '/repos/p' });
      runner.emit({ type: 'text', text: 'hice el cambio benigno.' });
      runner.finish({ status: 'completed', durationMs: 100 });
      await finished;

      const waitPromise = bridge.waitForAgents({
        agentIds: [agentId],
        timeoutMs: 5_000,
        stuckThresholdMs: 60_000,
      });
      await vi.waitFor(() => expect(runner.configs).toHaveLength(2));
      // El critic Haiku devuelve un output sin JSON block — el parser
      // sintetiza un flag low-severity 'critic output missing JSON block'.
      runner.finish({
        status: 'completed',
        durationMs: 50,
        finalResponse: 'Just plain text, no JSON block at the end.',
      });
      const result = await waitPromise;
      // El finding sintético queda visible en el wire-out.
      const findings = result.results[0].verification?.critic_findings;
      expect(findings).toHaveLength(1);
      expect(findings?.[0].severity).toBe('low');
      // Pero el agente NO se promueve — el critic no encontró nada real.
      expect(result.results[0].status).toBe('done');
      expect(result.results[0].verification?.auto_promoted_reason).toBeUndefined();
    });
  });
});
