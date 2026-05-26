/* ================================================================
 * project-scanner.test.ts — Tests del scanner de proyectos en disco.
 *
 * Estrategia: fixtures reales en /tmp/co-test-... (no mocks de fs)
 * para ejercitar readdir + filtering + cap. Git lookups se mockean
 * porque crear repos git temporales por test es lento y frágil.
 *
 * Test cases:
 *   - listing OK con N subfolders (incluye dirs ocultos filtrados).
 *   - dedup cuando dos roots apuntan al mismo proyecto.
 *   - cap a MAX_SUBFOLDERS_PER_ROOT cuando hay >N.
 *   - root inexistente: no tira, devuelve [] + log.
 *   - branch "HEAD" (detached) se reporta como vacío.
 *   - branch real + dirty true cuando git porcelain devuelve algo.
 *   - expansion de ~/ via expandUserHome.
 * ================================================================ */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  scanProjects,
  expandUserHome,
  type ScannerLogger,
} from '../project-scanner';

// === Mock de child_process.execFile ===
//
// Cada test programa qué devuelve git por path. El default es
// "no es repo git" (callback con err). Para simular un repo,
// preparamos `gitResponses[cwd][cmd]`.

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn() };
});

type GitResponse =
  | { ok: true; stdout: string }
  | { ok: false };

/** Programado por test antes de scanProjects. */
const gitResponses = new Map<string, Map<string, GitResponse>>();

function programGit(cwd: string, args: string[], response: GitResponse): void {
  const key = args.join(' ');
  if (!gitResponses.has(cwd)) gitResponses.set(cwd, new Map());
  gitResponses.get(cwd)!.set(key, response);
}

beforeEach(() => {
  gitResponses.clear();
  vi.mocked(childProcess.execFile).mockImplementation(
    ((file: string, args: readonly string[], _opts: unknown, callback: unknown) => {
      // `git -C <cwd> <subcmd...>`. cwd = args[1].
      void file;
      const cwd = args[1];
      const subArgs = args.slice(2).join(' ');
      const cb = callback as (err: Error | null, stdout?: string) => void;
      const programmed = gitResponses.get(cwd)?.get(subArgs);
      if (programmed && programmed.ok) {
        cb(null, programmed.stdout);
      } else {
        cb(new Error('not a git repo'));
      }
      return {} as ReturnType<typeof childProcess.execFile>;
    }) as unknown as typeof childProcess.execFile,
  );
});

// === Fixtures filesystem helpers ===

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'co-test-scanner-'));
}

function makeSubfolder(root: string, name: string): string {
  const full = path.join(root, name);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

const fixtureDirs: string[] = [];

afterEach(() => {
  for (const d of fixtureDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  fixtureDirs.length = 0;
});

function tmpRoot(): string {
  const d = makeTmpDir();
  fixtureDirs.push(d);
  return d;
}

// === Logger fake para verificar mensajes ===

function makeLogger(): ScannerLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    appendLine(msg: string): void {
      lines.push(msg);
    },
  };
}

// ====================================================================
// === Tests ==========================================================
// ====================================================================

describe('project-scanner / scanProjects', () => {
  it('lists direct subfolders of each root, filtering hidden dirs', async () => {
    const root = tmpRoot();
    makeSubfolder(root, 'project-a');
    makeSubfolder(root, 'project-b');
    makeSubfolder(root, '.git');
    makeSubfolder(root, '.vscode');
    // Archivo (no debe aparecer)
    fs.writeFileSync(path.join(root, 'README.md'), '#');

    const result = await scanProjects({ projectsRoot: [root] });
    expect(result.map((p) => p.name).sort()).toEqual(['project-a', 'project-b']);
    expect(result.every((p) => p.path.startsWith(root))).toBe(true);
  });

  it('dedups when two roots point to the same project path', async () => {
    const root = tmpRoot();
    makeSubfolder(root, 'shared');

    const result = await scanProjects({ projectsRoot: [root, root] });
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('shared');
  });

  it('caps subfolders to MAX_SUBFOLDERS_PER_ROOT (50) and logs warning', async () => {
    const root = tmpRoot();
    for (let i = 0; i < 60; i++) {
      makeSubfolder(root, `proj-${String(i).padStart(2, '0')}`);
    }
    const logger = makeLogger();
    const result = await scanProjects({ projectsRoot: [root], logger });
    expect(result.length).toBe(50);
    expect(logger.lines.some((l) => l.includes('capping to 50'))).toBe(true);
    // Sort alfabético: proj-00..proj-49.
    expect(result[0].name).toBe('proj-00');
    expect(result[49].name).toBe('proj-49');
  });

  it('returns [] and logs when a root does not exist', async () => {
    const missing = path.join(os.tmpdir(), 'co-test-missing-' + Date.now());
    const logger = makeLogger();
    const result = await scanProjects({ projectsRoot: [missing], logger });
    expect(result).toEqual([]);
    expect(logger.lines.some((l) => l.includes('cannot read project root'))).toBe(true);
  });

  it('treats branch "HEAD" (detached) as empty string', async () => {
    const root = tmpRoot();
    const projPath = makeSubfolder(root, 'detached-proj');
    programGit(projPath, ['branch', '--show-current'], {
      ok: true,
      stdout: 'HEAD\n',
    });
    programGit(projPath, ['--no-optional-locks', 'status', '--porcelain'], {
      ok: true,
      stdout: '',
    });

    const result = await scanProjects({ projectsRoot: [root] });
    expect(result.length).toBe(1);
    expect(result[0].branch).toBe('');
    expect(result[0].dirty).toBe(false);
  });

  it('reports branch + dirty=true when porcelain has output', async () => {
    const root = tmpRoot();
    const projPath = makeSubfolder(root, 'feat-branch-proj');
    programGit(projPath, ['branch', '--show-current'], {
      ok: true,
      stdout: 'feature/x\n',
    });
    programGit(projPath, ['--no-optional-locks', 'status', '--porcelain'], {
      ok: true,
      stdout: ' M src/foo.ts\n?? new.ts\n',
    });

    const result = await scanProjects({ projectsRoot: [root] });
    expect(result[0].branch).toBe('feature/x');
    expect(result[0].dirty).toBe(true);
  });

  it('reports branch="" + dirty=false when not a git repo', async () => {
    const root = tmpRoot();
    makeSubfolder(root, 'plain-folder');
    // Sin programGit → mock devuelve "not a git repo" para cualquier call.

    const result = await scanProjects({ projectsRoot: [root] });
    expect(result[0].branch).toBe('');
    expect(result[0].dirty).toBe(false);
  });
});

describe('project-scanner / expandUserHome', () => {
  it('expands ~/foo to <HOME>/foo', () => {
    const original = process.env.HOME;
    process.env.HOME = '/home/test';
    expect(expandUserHome('~/foo/bar')).toBe('/home/test/foo/bar');
    process.env.HOME = original;
  });

  it('returns ~ alone as HOME', () => {
    const original = process.env.HOME;
    process.env.HOME = '/home/test';
    expect(expandUserHome('~')).toBe('/home/test');
    process.env.HOME = original;
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandUserHome('/tmp/foo')).toBe('/tmp/foo');
  });

  it('leaves non-tilde relative paths unchanged', () => {
    expect(expandUserHome('relative/path')).toBe('relative/path');
  });
});
