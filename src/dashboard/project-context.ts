/* ================================================================
 * project-context.ts — Derivación de project/task/branch desde un cwd.
 *
 * Territorio neutral: lo consumen tanto el bridge (store del viewer)
 * como el scanner-controller (sesiones históricas) y el wiring del
 * ingester en extension.ts. Vivía dentro de `bridge.ts` cuando ese
 * archivo era el supervisor de orquestación; al re-enfocar a viewer
 * se extrajo acá para que nadie dependa del archivo que se demolió.
 *
 * Dos variantes:
 *   - `deriveProjectContext`: incluye `branch` vía `git` síncrono.
 *     Apta para eventos de baja frecuencia (un nacimiento de agente).
 *   - `deriveProjectContextPure`: NO ejecuta git. Hot path del session
 *     scanner (cientos de .jsonl por scan); el branch ya viene en el
 *     header del JSONL.
 * ================================================================ */

import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Deriva (project, task, branch) del cwd siguiendo §9.2 del brief.
 *
 *   1. options.project explícito gana.
 *   2. cwd matchea `<root>/<project>/...` para algún root → ese segmento.
 *   3. cwd matchea workspace folder → basename del folder.
 *   4. fallback basename(cwd).
 *
 * `task` solo cubre la convención `<root>/<project>/tasks/<task>/...`
 * (el caso 1 del brief §9.3). La heurística alternativa de "primer
 * subfolder sin nivel `tasks/`" se descarta deliberadamente: infiere
 * tasks falsos en estructuras planas de repos no-Trescloud. Sin
 * match, `task = ''` y la UI muestra el fallback (línea solo con
 * branch).
 *
 * `branch` vía `git -C <cwd> branch --show-current` sync. Si el cwd
 * no es git repo, cadena vacía. Sync porque el costo es ~10-30ms y
 * facilita razonamiento: el snapshot inicial ya viene completo.
 *
 * Exportable y puro a propósito — testeable con casos sintéticos
 * sin necesidad de filesystem.
 */
export function deriveProjectContext(
  cwd: string,
  projectsRoot: string[],
  override?: string,
  workspaceFolders?: readonly string[],
): { project: string; task: string; branch: string } {
  const { project, task } = deriveProjectContextPure(
    cwd,
    projectsRoot,
    override,
    workspaceFolders,
  );
  const branch = readGitBranch(cwd);
  return { project, task, branch };
}

/**
 * Variante 100% pura de `deriveProjectContext`: NO ejecuta `git`.
 *
 * Hot path del session scanner — clasifica cada uno de los ~260
 * `.jsonl` históricos por proyecto. Si reusáramos la versión con
 * git, harían N forks de `git branch` síncronos en el event loop
 * del extension host por cada scan (cada 60s con auto-refresh
 * default), congelando VS Code varios segundos.
 *
 * El scanner además ya tiene el `gitBranch` autoritativo dentro
 * del propio JSONL — no necesita re-calcularlo del filesystem.
 *
 * Acepta `firstUserPrompt` opcional para activar la heurística de
 * derivación desde el contenido del prompt: el cwd del JSONL viene
 * del workspace folder de VS Code, no de la subcarpeta donde está
 * la tarea. Si el prompt menciona un path absoluto dentro de un
 * projectsRoot, ese path es mejor señal que el cwd genérico.
 */
export function deriveProjectContextPure(
  cwd: string,
  projectsRoot: string[],
  override?: string,
  workspaceFolders?: readonly string[],
  firstUserPrompt?: string,
  signalText?: string,
): { project: string; task: string } {
  const normCwd = normalizePath(cwd);
  let project = '';
  let task = '';

  if (override) {
    project = override;
  } else {
    // === Paso 1: match cwd contra projectsRoot ===
    // Caso ideal — workspace = ~/git19/docs/proj/. El user lo controla
    // explícito y es prioridad sobre todo lo demás.
    for (const root of projectsRoot) {
      const normRoot = normalizePath(root);
      if (isSubPath(normCwd, normRoot)) {
        const rel = normCwd.slice(normRoot.length + 1);
        const segments = rel.split('/');
        if (segments[0]) {
          project = segments[0];
          if (segments[1] === 'tasks' && segments[2]) {
            task = segments[2];
          }
        }
        break;
      }
    }

    // === Paso 2: heurística del prompt ===
    // ANTES que workspace folders porque el prompt apunta a un
    // subpath específico (proyecto/tarea real) mientras que el
    // workspace folder es típicamente un parent genérico (~/git19/).
    // Ejemplo del bug que dispara este orden: workspace=~/git18,
    // cwd=/home/trescloud/git18, prompts mencionan
    // docs/ecuadorian-hr18/... → queremos `ecuadorian-hr18`, NO
    // `git18` (basename del workspace).
    if (!project && projectsRoot.length > 0) {
      const haystack = [firstUserPrompt, signalText]
        .filter(Boolean)
        .join('\n');
      if (haystack) {
        const fromPrompt = derivePathFromPrompt(haystack, projectsRoot, normCwd);
        if (fromPrompt) {
          project = fromPrompt.project;
          task = fromPrompt.task;
        }
      }
    }

    // === Paso 3: match cwd contra workspace folders ===
    // Fallback genérico cuando el prompt no aportó señal. Pasa con
    // sesiones que no mencionan paths específicos en ningún user
    // prompt ni en tool_use.
    if (!project) {
      const folders = workspaceFolders ?? readWorkspaceFolders();
      for (const folder of folders) {
        const normFolder = normalizePath(folder);
        if (normCwd === normFolder || isSubPath(normCwd, normFolder)) {
          project = path.basename(normFolder);
          break;
        }
      }
    }

    // === Paso 4: fallback final ===
    if (!project) {
      project = path.basename(normCwd) || normCwd;
    }
  }

  return { project, task };
}

/**
 * Busca el primer path en `prompt` que matchee algún `projectsRoot`
 * y devuelve `{project, task}` derivados. Acepta:
 *
 *   - Paths absolutos: `/home/user/git19/docs/proj/file.py`.
 *   - Paths relativos (si `baseCwd` se pasa): `docs/proj/file.py`
 *     resuelve contra baseCwd → matchea projectsRoot. Esto cubre
 *     el caso "tool_use file_path=docs/x/y.py" cuando Claude
 *     trabaja desde el workspace folder.
 *
 * Regex conservador: solo letras, números, `._-` en cada segmento,
 * mínimo 2 segmentos. Excluye URLs y paths con espacios.
 *
 * Exportable para tests; null si no encuentra match.
 */
export function derivePathFromPrompt(
  prompt: string,
  projectsRoot: string[],
  baseCwd?: string,
): { project: string; task: string } | null {
  // Path absoluto: `/foo/bar/baz`. Lookbehind para evitar matchear
  // "//comentarios" o "http://...".
  const ABS_PATH_REGEX = /(?:^|[\s(`"'])(\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)/g;
  // Path relativo: `foo/bar/baz` (mínimo 2 segmentos, no precedido
  // de `/` o letras — esto excluye paths absolutos y URLs como
  // "github.com/user/repo"). Usado solo cuando baseCwd está
  // disponible para resolverlos.
  const REL_PATH_REGEX =
    /(?:^|[\s(`"'])((?:[A-Za-z0-9._-]+\/){1,}[A-Za-z0-9._-]+)/g;

  const normRoots = projectsRoot.map((r) => normalizePath(r));

  // Helper: intenta matchear un path canonicalizado contra los roots.
  function tryMatch(candidate: string): { project: string; task: string } | null {
    for (const root of normRoots) {
      if (isSubPath(candidate, root)) {
        const rel = candidate.slice(root.length + 1);
        const segments = rel.split('/');
        if (segments[0]) {
          const project = segments[0];
          let task = '';
          if (segments[1] === 'tasks' && segments[2]) {
            task = segments[2];
          }
          return { project, task };
        }
      }
    }
    return null;
  }

  // === Pass 1: paths absolutos ===
  let m: RegExpExecArray | null;
  while ((m = ABS_PATH_REGEX.exec(prompt)) !== null) {
    const matched = tryMatch(normalizePath(m[1]));
    if (matched) return matched;
  }

  // === Pass 2: paths relativos resueltos contra baseCwd ===
  // Solo si tenemos baseCwd (el cwd del .jsonl) — sin él no podemos
  // resolver. Esto captura "file_path: docs/equipo-ya/foo.py" en
  // tool_use de Claude cuando estaba en /home/trescloud/git19.
  if (baseCwd) {
    const normBase = normalizePath(baseCwd);
    while ((m = REL_PATH_REGEX.exec(prompt)) !== null) {
      const raw = m[1];
      // Skip si arranca con segmento conocido como URL ("https",
      // "http", "ftp") o esquema con dos puntos.
      if (/^(https?|ftp|file|git):/i.test(raw)) continue;
      // Skip si parece dominio (ej. "github.com/user/repo") — un
      // primer segmento con punto y todo letras suele ser host.
      const firstSeg = raw.split('/')[0];
      if (/\./.test(firstSeg) && /^[a-z0-9.-]+$/i.test(firstSeg)) continue;
      const resolved = normalizePath(path.join(normBase, raw));
      const matched = tryMatch(resolved);
      if (matched) return matched;
    }
  }
  return null;
}

// === Helpers de path / git ===

export function normalizePath(p: string): string {
  // path.resolve normaliza separadores + resuelve .. — suficiente
  // para nuestros matches. NO resolvemos symlinks (realpath) porque
  // el user que setea projectsRoot generalmente apunta al path
  // canónico que él tipea.
  return path.resolve(expandUserHome(p));
}

export function isSubPath(child: string, parent: string): boolean {
  return child.startsWith(parent + '/') || child === parent;
}

export function expandUserHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    const home = process.env.HOME ?? '';
    return p === '~' ? home : path.join(home, p.slice(2));
  }
  return p;
}

function readWorkspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((w) => w.uri.fsPath);
}

export function readGitBranch(cwd: string): string {
  try {
    const out = childProcess.execFileSync(
      'git',
      ['-C', cwd, 'branch', '--show-current'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      },
    );
    return out.trim();
  } catch {
    // No es git repo / git no instalado / cwd inexistente — fallback vacío.
    return '';
  }
}
