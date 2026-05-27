// === Tests del CLAUDE.md workspace injector ===
//
// Usa tmpdir aislado por test. NO toca el filesystem real del developer.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  END_TAG,
  injectAuto,
  injectIntoClaudeMdFile,
  injectIntoProjectsRoots,
  SECTION_BODY,
  START_TAG,
} from '../claude-md-injector';

describe('injectIntoClaudeMdFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'co-claude-md-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('skipea con file_missing cuando el archivo no existe (modo auto)', async () => {
    const filePath = join(tmpDir, 'CLAUDE.md');
    const result = await injectIntoClaudeMdFile(filePath);
    expect(result).toEqual({
      path: filePath,
      status: 'skipped',
      reason: 'file_missing',
    });
  });

  it('crea el archivo cuando createIfMissing=true', async () => {
    const filePath = join(tmpDir, 'CLAUDE.md');
    const result = await injectIntoClaudeMdFile(filePath, {
      createIfMissing: true,
    });
    expect(result.status).toBe('created');

    const content = await readFile(filePath, 'utf8');
    expect(content).toContain(START_TAG);
    expect(content).toContain(END_TAG);
    expect(content).toContain('claude-orchestrator');
  });

  it('appendea sección al final cuando los tags no existen', async () => {
    const filePath = join(tmpDir, 'CLAUDE.md');
    const original = '# Mi proyecto\n\nDescripción del proyecto.\n';
    await writeFile(filePath, original);

    const result = await injectIntoClaudeMdFile(filePath);
    expect(result.status).toBe('updated');

    const content = await readFile(filePath, 'utf8');
    expect(content).toContain('# Mi proyecto');
    expect(content).toContain('Descripción del proyecto.');
    expect(content).toContain(START_TAG);
    expect(content).toContain(END_TAG);
    // El contenido original debe quedar ANTES de los tags.
    expect(content.indexOf('# Mi proyecto')).toBeLessThan(
      content.indexOf(START_TAG),
    );
  });

  it('reemplaza solo el bloque entre tags cuando ya están presentes', async () => {
    const filePath = join(tmpDir, 'CLAUDE.md');
    const original = `# Header

${START_TAG}
contenido viejo y obsoleto
${END_TAG}

## Sección de proyecto

contenido del user que NO debemos tocar.`;
    await writeFile(filePath, original);

    const result = await injectIntoClaudeMdFile(filePath);
    expect(result.status).toBe('updated');

    const content = await readFile(filePath, 'utf8');
    expect(content).toContain('# Header');
    expect(content).toContain('## Sección de proyecto');
    expect(content).toContain('contenido del user que NO debemos tocar');
    expect(content).not.toContain('contenido viejo y obsoleto');
    expect(content).toContain('MCP server: claude-orchestrator');
  });

  it('devuelve unchanged cuando el contenido ya matchea', async () => {
    const filePath = join(tmpDir, 'CLAUDE.md');
    const original = `# Header\n\n${SECTION_BODY}\n`;
    await writeFile(filePath, original);

    const result = await injectIntoClaudeMdFile(filePath);
    expect(result.status).toBe('unchanged');
  });

  it('preserva contenido user antes Y después de los tags al actualizar', async () => {
    const filePath = join(tmpDir, 'CLAUDE.md');
    const before = '## Reglas del proyecto\n\nUsar TypeScript strict.\n\n';
    const after = '\n\n## Cierre\n\nSeguir convenciones.\n';
    const original = `${before}${START_TAG}\nVIEJO\n${END_TAG}${after}`;
    await writeFile(filePath, original);

    await injectIntoClaudeMdFile(filePath);

    const content = await readFile(filePath, 'utf8');
    expect(content.startsWith(before)).toBe(true);
    expect(content.endsWith(after)).toBe(true);
    expect(content).not.toContain('VIEJO');
  });
});

describe('injectIntoProjectsRoots', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'co-projects-root-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('itera subdirectorios y solo inyecta en los que ya tienen CLAUDE.md (modo auto)', async () => {
    // Estructura:
    //   tmpDir/projectA/CLAUDE.md  ← existe, debe actualizarse
    //   tmpDir/projectB/           ← sin CLAUDE.md, skip
    //   tmpDir/projectC/CLAUDE.md  ← existe, debe actualizarse
    await mkdir(join(tmpDir, 'projectA'));
    await mkdir(join(tmpDir, 'projectB'));
    await mkdir(join(tmpDir, 'projectC'));
    await writeFile(join(tmpDir, 'projectA', 'CLAUDE.md'), '# A\n');
    await writeFile(join(tmpDir, 'projectC', 'CLAUDE.md'), '# C\n');

    const summary = await injectIntoProjectsRoots([tmpDir]);

    // Solo 2 archivos updated; B skipeado silenciosamente.
    expect(summary.results).toHaveLength(2);
    const statuses = summary.results.map((r) => r.status);
    expect(statuses).toEqual(['updated', 'updated']);

    const contentA = await readFile(join(tmpDir, 'projectA', 'CLAUDE.md'), 'utf8');
    const contentC = await readFile(join(tmpDir, 'projectC', 'CLAUDE.md'), 'utf8');
    expect(contentA).toContain(START_TAG);
    expect(contentC).toContain(START_TAG);
    expect(contentA).toContain('# A');
    expect(contentC).toContain('# C');
  });

  it('createIfMissing=true crea CLAUDE.md en subdirectorios que no lo tienen', async () => {
    await mkdir(join(tmpDir, 'projectA'));
    await mkdir(join(tmpDir, 'projectB'));
    await writeFile(join(tmpDir, 'projectA', 'CLAUDE.md'), '# A\n');

    const summary = await injectIntoProjectsRoots([tmpDir], {
      createIfMissing: true,
    });

    expect(summary.results).toHaveLength(2);
    const byStatus = summary.results.map((r) => r.status).sort();
    expect(byStatus).toEqual(['created', 'updated']);
  });

  it('skipea projectsRoot que no existen (ENOENT) sin tirar error', async () => {
    const nonExistent = join(tmpDir, 'nonexistent');
    const summary = await injectIntoProjectsRoots([nonExistent]);
    expect(summary.scannedRoots).toContain(nonExistent);
    expect(summary.results).toHaveLength(0);
  });

  it('reporta error para projectsRoot con permisos denegados (no ENOENT)', async () => {
    // Imposible reproducir perms portable en CI; smoke con un path no-dir.
    const filePath = join(tmpDir, 'plain-file');
    await writeFile(filePath, 'not a dir');

    const summary = await injectIntoProjectsRoots([filePath]);
    // readdir sobre un archivo regular tira ENOTDIR — el helper lo
    // reporta como error (no ENOENT silencioso).
    expect(summary.results.some((r) => r.status === 'error')).toBe(true);
  });

  it('ignora archivos que no son directorios al escanear el root', async () => {
    await mkdir(join(tmpDir, 'real-project'));
    await writeFile(join(tmpDir, 'real-project', 'CLAUDE.md'), '# proj\n');
    await writeFile(join(tmpDir, 'README.md'), 'not a project');

    const summary = await injectIntoProjectsRoots([tmpDir]);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].status).toBe('updated');
  });

  it('expande ~ del path del projectsRoot', async () => {
    // No podemos escribir en ~/ del developer; verificamos que el
    // expand no tira con un path que empieza con ~/ aunque no exista.
    const summary = await injectIntoProjectsRoots(['~/this-does-not-exist-co-test']);
    expect(summary.scannedRoots[0]).toMatch(/this-does-not-exist-co-test$/);
    expect(summary.results).toHaveLength(0);
  });
});

describe('injectAuto — workspace folders + recursive walk', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'co-auto-inject-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('inyecta en CLAUDE.md del workspace folder activo (raíz directa)', async () => {
    // Estructura típica: workspace = ~/git19, con CLAUDE.md en la raíz.
    const workspace = join(tmpDir, 'git19');
    await mkdir(workspace);
    await writeFile(join(workspace, 'CLAUDE.md'), '# git19 root\n');

    const summary = await injectAuto([], [workspace]);

    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].status).toBe('updated');
    expect(summary.results[0].path).toBe(join(workspace, 'CLAUDE.md'));
  });

  it('escanea recursivamente projectsRoot hasta maxDepth', async () => {
    // Estructura: projectsRoot=tmpDir; CLAUDE.md en depth 1, 2, 3.
    const root = tmpDir;
    await mkdir(join(root, 'projectA'));
    await mkdir(join(root, 'projectA/tasks'));
    await mkdir(join(root, 'projectA/tasks/tarea_X'));
    await writeFile(join(root, 'projectA/CLAUDE.md'), '# A\n');
    await writeFile(join(root, 'projectA/tasks/tarea_X/CLAUDE.md'), '# X\n');

    const summary = await injectAuto([root], []);

    // Encuentra ambos CLAUDE.md (depth 1 y depth 3).
    expect(summary.results).toHaveLength(2);
    expect(summary.results.every((r) => r.status === 'updated')).toBe(true);
  });

  it('respeta maxDepth (no recurre más allá del límite)', async () => {
    const root = tmpDir;
    await mkdir(join(root, 'a/b/c/d'), { recursive: true });
    await writeFile(join(root, 'a/b/c/d/CLAUDE.md'), '# deep\n');

    const summary = await injectAuto([root], [], { maxDepth: 2 });
    // Depth 4 (a/b/c/d) > maxDepth 2 → no encuentra.
    expect(summary.results).toHaveLength(0);
  });

  it('ignora directorios SKIP_DIRS (node_modules, .git, dist, etc.)', async () => {
    const root = tmpDir;
    await mkdir(join(root, 'node_modules/some-pkg'), { recursive: true });
    await mkdir(join(root, '.git/hooks'), { recursive: true });
    await mkdir(join(root, 'out/build'), { recursive: true });
    await writeFile(join(root, 'node_modules/some-pkg/CLAUDE.md'), '# noise\n');
    await writeFile(join(root, '.git/CLAUDE.md'), '# noise\n');
    await writeFile(join(root, 'out/build/CLAUDE.md'), '# noise\n');
    await writeFile(join(root, 'CLAUDE.md'), '# real\n');

    const summary = await injectAuto([root], []);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].path).toBe(join(root, 'CLAUDE.md'));
  });

  it('ignora directorios dot-prefix (.cache, .venv, .pytest_cache, etc.)', async () => {
    const root = tmpDir;
    await mkdir(join(root, '.cache'));
    await mkdir(join(root, '.pytest_cache'));
    await writeFile(join(root, '.cache/CLAUDE.md'), '# noise\n');
    await writeFile(join(root, '.pytest_cache/CLAUDE.md'), '# noise\n');
    await writeFile(join(root, 'CLAUDE.md'), '# real\n');

    const summary = await injectAuto([root], []);
    expect(summary.results).toHaveLength(1);
  });

  it('dedup: workspace folder == subdir de projectsRoot → inyecta una sola vez', async () => {
    const root = tmpDir;
    const workspace = join(root, 'sub');
    await mkdir(workspace);
    await writeFile(join(workspace, 'CLAUDE.md'), '# sub\n');

    const summary = await injectAuto([root], [workspace]);
    // El archivo /tmpDir/sub/CLAUDE.md debe aparecer 1 sola vez.
    const paths = summary.results.map((r) => r.path);
    const uniquePaths = new Set(paths);
    expect(paths.length).toBe(uniquePaths.size);
  });

  it('procesa workspace folders y projectsRoot simultáneamente', async () => {
    const workspace = join(tmpDir, 'ws');
    const projectsRoot = join(tmpDir, 'projects');
    await mkdir(workspace);
    await mkdir(projectsRoot);
    await mkdir(join(projectsRoot, 'projA'));
    await writeFile(join(workspace, 'CLAUDE.md'), '# ws\n');
    await writeFile(join(projectsRoot, 'projA/CLAUDE.md'), '# projA\n');

    const summary = await injectAuto([projectsRoot], [workspace]);
    expect(summary.results).toHaveLength(2);
    expect(summary.results.every((r) => r.status === 'updated')).toBe(true);
  });
});
