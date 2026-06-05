/* ================================================================
 * project-context.test.ts — Derivación project/task/branch del cwd.
 *
 * Cubre los tres helpers puros que el bridge (store del viewer) y el
 * scanner-controller comparten:
 *   1. `deriveProjectContext`     — con branch (git síncrono).
 *   2. `derivePathFromPrompt`     — match de paths en texto.
 *   3. `deriveProjectContextPure` — heurística sin git (hot path del
 *      session scanner).
 *
 * `node:child_process` se mockea a nivel módulo: `deriveProjectContext`
 * usa `execFileSync('git', ...)` para leer la branch. El mock devuelve
 * cadena vacía ("no es repo git"), suficiente para tests de project/task.
 * ================================================================ */

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => ''),
}));

import {
  deriveProjectContext,
  deriveProjectContextPure,
  derivePathFromPrompt,
} from '../project-context';

// =====================================================================
// === deriveProjectContext ============================================
// =====================================================================

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
    // pero `segments[0]` es '' (string vacía después del slice). Sale
    // del loop sin setear project y cae a folders. Para que resuelva
    // necesitamos que algún folder contenga al cwd — acá el folder
    // coincide con el root mismo, así basename(folder) da el project.
    const ctx = deriveProjectContext('/repos/myws', ['/repos/myws'], undefined, [
      '/repos/myws',
    ]);
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
    // task queda en '' por diseño (el override no implica convención).
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
// === derivePathFromPrompt ============================================
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
    // cwd del .jsonl = /home/trescloud/git19. Sin baseCwd no match-ea;
    // con baseCwd resuelve a /home/trescloud/git19/docs/equipo-ya/foo.py.
    const out = derivePathFromPrompt(
      'tool input: docs/equipo-ya/tasks/hr18/main.py',
      ['/home/trescloud/git19/docs'],
      '/home/trescloud/git19',
    );
    expect(out).toEqual({ project: 'equipo-ya', task: 'hr18' });
  });

  it('paths absolutos del prompt ganan sobre relativos del mismo prompt', () => {
    const out = derivePathFromPrompt(
      'Mira /home/trescloud/git19/docs/proj-a/foo y también docs/proj-b/bar',
      ['/home/trescloud/git19/docs'],
      '/home/trescloud/git19',
    );
    expect(out).toEqual({ project: 'proj-a', task: '' });
  });

  it('no matchea URLs http como paths relativos', () => {
    const out = derivePathFromPrompt(
      'Ver https://github.com/user/repo/foo y luego docs/proj-real/bar',
      ['/home/trescloud/git19/docs'],
      '/home/trescloud/git19',
    );
    expect(out).toEqual({ project: 'proj-real', task: '' });
  });

  it('no matchea dominios sueltos (host con punto) como paths', () => {
    const out = derivePathFromPrompt(
      'Mira example.com/foo/bar.html y luego docs/proj-real/bar',
      ['/home/trescloud/git19/docs'],
      '/home/trescloud/git19',
    );
    expect(out).toEqual({ project: 'proj-real', task: '' });
  });

  it('skip de path relativo sin baseCwd (defensivo)', () => {
    const out = derivePathFromPrompt('docs/equipo-ya/foo', [
      '/home/trescloud/git19/docs',
    ]);
    expect(out).toBe(null);
  });
});

// =====================================================================
// === deriveProjectContextPure — heurística v2 con signalText =========
// =====================================================================

describe('deriveProjectContextPure — heurística v2 con signalText', () => {
  const ROOTS = ['/home/trescloud/git19/docs'];

  it('usa signalText cuando el primer prompt es conversacional sin paths', () => {
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

  it('PROMPT gana sobre workspace folder cuando ambos podrían matchear', () => {
    // Repro del bug E2E: workspace = ~/git18, cwd del .jsonl =
    // /home/trescloud/git18 (igual al workspace), prompts mencionan
    // docs/X. Sin el reorden, workspaceFolders daba project='git18'.
    const ctx = deriveProjectContextPure(
      '/home/trescloud/git18',
      ROOTS,
      undefined,
      ['/home/trescloud/git18'],
      undefined,
      '/home/trescloud/git19/docs/equipo-ya/foo.py',
    );
    expect(ctx).toEqual({ project: 'equipo-ya', task: '' });
  });

  it('repro del workspace=~/git18 + prompts apuntando a docs/X', () => {
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

  it('usa el prompt cuando el cwd genérico no matchea', () => {
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

  it('no requiere prompt: si no se pasa, se salta el paso sin tirar', () => {
    const ctx = deriveProjectContextPure(
      '/home/trescloud/git19',
      ROOTS,
      undefined,
      [],
    );
    expect(ctx).toEqual({ project: 'git19', task: '' });
  });
});
