/* ================================================================
 * project-scanner.ts — Descubre proyectos desde el filesystem.
 *
 * Lee `claudeActivityViewer.projectsRoot` y lista cada subfolder
 * directo como un proyecto candidato. Por cada uno consulta git
 * branch + porcelain para sacar branch + dirty flag.
 *
 * Stateless por diseño: cada `scanProjects` arranca de cero,
 * sin caché. Si la performance lo justifica en v0.2 se agrega un
 * índice persistido, pero hoy el costo es <100ms por root con 50
 * subfolders.
 *
 * Por qué fs sync + git async:
 *   readdir es trivial y no vale orquestar. `git -C ... branch`
 *   bloquea ~10-30ms por proyecto; con N=50 son 1.5s sync. Lo
 *   paralelizamos con Promise.allSettled — cada fork de git es
 *   independiente y el resultado se ensambla al final.
 *
 * Cap defensivo: máx 50 subfolders por root. Si el user apunta a
 * `~/git19/` (que tiene ~30 proyectos Trescloud) entra entero; si
 * apunta accidentalmente a `~` (cientos de subfolders) podamos +
 * loggeamos. El cap evita un scan accidental de 5+ minutos.
 * ================================================================ */

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProjectFromDisk } from '../shared/dashboard-protocol';

// === Constantes ===

const MAX_SUBFOLDERS_PER_ROOT = 50;
const GIT_TIMEOUT_MS = 2000;

// === Tipos internos ===

/**
 * Output channel mínimo que necesitamos. Recibimos cualquier cosa
 * con `appendLine` así los tests pasan un fake sin instanciar
 * vscode.OutputChannel real.
 */
export interface ScannerLogger {
  appendLine(message: string): void;
}

export interface ScanProjectsOptions {
  /** Roots ya expandidos (~/ → home) y canonicalizados. */
  projectsRoot: string[];
  /** Para diagnóstico al OutputChannel — opcional en tests. */
  logger?: ScannerLogger;
}

// ====================================================================
// === API pública ====================================================
// ====================================================================

/**
 * Lista todos los proyectos descubiertos a lo largo de los roots.
 * Dedup por path canónico (un mismo proyecto en dos roots solo
 * aparece una vez).
 *
 * Errores silenciosos por diseño: un root inexistente o sin
 * permisos NO tira; se loggea y se sigue. La UI prefiere lista
 * parcial vs error blocking.
 */
export async function scanProjects(
  options: ScanProjectsOptions,
): Promise<ProjectFromDisk[]> {
  const seen = new Map<string, ProjectFromDisk>();

  for (const rawRoot of options.projectsRoot) {
    const root = path.resolve(rawRoot);
    const entries = await listSubfoldersSafe(root, options.logger);
    if (entries.length === 0) continue;

    // === Cap por root ===
    // Si el root tiene más de N, ordenamos alfabéticamente y
    // tomamos los primeros — comportamiento estable + predecible.
    // Loggeamos para que el user note si está poniendo un root
    // muy genérico.
    let capped = entries;
    if (entries.length > MAX_SUBFOLDERS_PER_ROOT) {
      options.logger?.appendLine(
        `[scanner] project root "${root}" has ${entries.length} subfolders; capping to ${MAX_SUBFOLDERS_PER_ROOT}.`,
      );
      capped = entries.slice().sort().slice(0, MAX_SUBFOLDERS_PER_ROOT);
    }

    // === Paralelizar git lookups ===
    // Cada git -C es ~10-30ms; con allSettled los corremos en
    // paralelo y absorbemos fallos individuales sin tirar el batch.
    const projectPaths = capped.map((name) => path.join(root, name));
    const gitResults = await Promise.allSettled(
      projectPaths.map((p) => inspectGit(p)),
    );

    for (let i = 0; i < projectPaths.length; i++) {
      const projPath = projectPaths[i];
      const name = path.basename(projPath);
      const git = gitResults[i];
      const branch = git.status === 'fulfilled' ? git.value.branch : '';
      const dirty = git.status === 'fulfilled' ? git.value.dirty : false;

      // Dedup por path canónico. Si dos roots apuntan al mismo
      // proyecto (ej. via symlink o repetición accidental), la
      // primera entrada gana.
      if (seen.has(projPath)) continue;
      seen.set(projPath, { path: projPath, name, branch, dirty });
    }
  }

  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ====================================================================
// === Helpers internos ===============================================
// ====================================================================

/**
 * `readdirSync` envuelto en try/catch + filtro de directorios
 * ocultos y no-directorios. Devuelve `[]` ante cualquier error
 * (root inexistente, ENOTDIR, EACCES) — la lista parcial es OK.
 */
async function listSubfoldersSafe(
  root: string,
  logger?: ScannerLogger,
): Promise<string[]> {
  try {
    const dirents = await fs.promises.readdir(root, { withFileTypes: true });
    return dirents
      .filter((d) => d.isDirectory())
      .filter((d) => !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch (err) {
    logger?.appendLine(
      `[scanner] cannot read project root "${root}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Lee branch + dirty flag de un directorio. Si NO es repo git
 * devuelve {branch:'', dirty:false} sin tirar.
 *
 * Usamos execFile (no exec) para evitar shell interpolation —
 * paths con espacios o caracteres especiales pasan literales.
 */
async function inspectGit(
  cwd: string,
): Promise<{ branch: string; dirty: boolean }> {
  const branch = await runGit(cwd, ['branch', '--show-current']);
  if (branch === null) {
    // No es git repo. dirty sin sentido — false explícito.
    return { branch: '', dirty: false };
  }
  // `git status --porcelain` retorna lista de paths con cambios;
  // empty significa clean. Usamos `--no-optional-locks` para
  // evitar competir con un VS Code git que tenga el index lockeado.
  const status = await runGit(cwd, [
    '--no-optional-locks',
    'status',
    '--porcelain',
  ]);
  const dirty = status !== null && status.trim().length > 0;
  // branch puede ser "HEAD" (detached). Lo dejamos como string
  // vacío en el wire para que la UI no muestre "branch HEAD" que
  // confunde al user.
  const branchClean = branch.trim() === 'HEAD' ? '' : branch.trim();
  return { branch: branchClean, dirty };
}

/**
 * Wrapper async de `git -C <cwd> <args>`. Retorna stdout o null
 * si el comando falla por cualquier razón (incluye "no es repo
 * git"). NO loggea — el caller decide qué hacer con null.
 */
function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    childProcess.execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf-8', timeout: GIT_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// `expandUserHome` vive en `project-context.ts` (módulo de helpers de
// path). Lo re-exportamos acá para no duplicar la definición y para que
// los consumidores históricos (scanner-controller, tests) lo sigan
// importando desde este módulo sin cambios.
export { expandUserHome } from './project-context';
