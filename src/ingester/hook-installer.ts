/* ================================================================
 * hook-installer.ts — Instala/desinstala el forwarder global de hooks
 * en ~/.claude/settings.json de forma idempotente.
 *
 * Mecanismo (precedente: pixel-agents):
 *   1. Copia el forwarder bundleado a un path estable
 *      (~/.claude/claude-activity-viewer/hook.cjs).
 *   2. Agrega una entrada `node "<dest>"` a los arrays de hooks de los
 *      7 eventos del ciclo de vida.
 *
 * Garantías:
 *   - Idempotente: re-instalar no duplica entradas (matchea por el path
 *     del forwarder).
 *   - No invasivo: PRESERVA las entradas de otros hooks del usuario
 *     (pixel-agents y cualquier otro) — solo agrega/quita las nuestras.
 *   - Seguro: backup del settings.json antes de tocarlo; escritura
 *     atómica (tmp + rename); si el settings está corrupto, ABORTA en
 *     vez de clobberearlo.
 *   - Reversible: `uninstallHook` quita SOLO nuestras entradas y borra
 *     el forwarder copiado.
 *
 * Paths inyectables para que los tests corran contra un tmpdir y nunca
 * toquen el ~/.claude real del developer.
 * ================================================================ */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOOK_EVENT_NAMES } from './hook-events';

const HOOK_DIR_NAME = 'claude-activity-viewer';
const FORWARDER_NAME = 'hook.cjs';
const EVENTS_FILE_NAME = 'events.jsonl';
const BACKUP_SUFFIX = '.claude-activity-viewer.bak';
const HOOK_TIMEOUT_SEC = 5;

export interface HookPaths {
  settingsPath: string;
  hookHome: string;
  forwarderDest: string;
  eventsFile: string;
}

/**
 * Paths canónicos derivados del home del usuario. El extension host
 * los usa en producción; los tests pasan los suyos directamente a las
 * funciones.
 */
export function defaultHookPaths(homeDir: string = os.homedir()): HookPaths {
  const claudeDir = path.join(homeDir, '.claude');
  const hookHome = path.join(claudeDir, HOOK_DIR_NAME);
  return {
    settingsPath: path.join(claudeDir, 'settings.json'),
    hookHome,
    forwarderDest: path.join(hookHome, FORWARDER_NAME),
    eventsFile: path.join(hookHome, EVENTS_FILE_NAME),
  };
}

/**
 * Entrada de hook que instalamos en cada evento. El path del spool se
 * pasa como argv al forwarder → el installer (TS) es la única fuente de
 * verdad del path; el forwarder no la duplica.
 */
export function buildHookEntry(forwarderDest: string, eventsFile: string): HookEntry {
  return {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: `node "${forwarderDest}" "${eventsFile}"`,
        timeout: HOOK_TIMEOUT_SEC,
      },
    ],
  };
}

interface HookCommand {
  type?: string;
  command?: string;
  timeout?: number;
}
interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

/** True si la entrada referencia NUESTRO forwarder (no el de otro hook). */
function isOurEntry(entry: unknown, forwarderDest: string): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const hooks = (entry as HookEntry).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) => typeof h?.command === 'string' && h.command.includes(forwarderDest),
  );
}

export interface InstallOptions {
  /** Forwarder bundleado en la extensión (resources/hooks/activity-viewer-hook.cjs). */
  forwarderSource: string;
  paths: HookPaths;
}

export interface InstallResult {
  status: 'installed' | 'unchanged' | 'error';
  installed: string[];
  alreadyPresent: string[];
  /** Eventos cuyo valor en `hooks` no era un array → no tocados. */
  skipped: string[];
  message?: string;
  forwarderDest: string;
  eventsFile: string;
}

/**
 * Copia el forwarder y agrega nuestras entradas a los 7 eventos.
 * Idempotente. Aborta sin escribir si el settings.json está corrupto.
 */
export function installHook(opts: InstallOptions): InstallResult {
  const { forwarderSource, paths } = opts;
  const base = {
    forwarderDest: paths.forwarderDest,
    eventsFile: paths.eventsFile,
  };

  try {
    fs.mkdirSync(paths.hookHome, { recursive: true });
    fs.copyFileSync(forwarderSource, paths.forwarderDest);
  } catch (err) {
    return {
      status: 'error',
      installed: [],
      alreadyPresent: [],
      skipped: [],
      message: `cannot copy forwarder: ${errMsg(err)}`,
      ...base,
    };
  }

  const read = readSettings(paths.settingsPath);
  if (!read.ok) {
    return {
      status: 'error',
      installed: [],
      alreadyPresent: [],
      skipped: [],
      message: read.message,
      ...base,
    };
  }

  const settings = read.data;
  const hooks = asRecord(settings.hooks) ?? {};
  settings.hooks = hooks;

  const installed: string[] = [];
  const alreadyPresent: string[] = [];
  const skipped: string[] = [];
  const entry = buildHookEntry(paths.forwarderDest, paths.eventsFile);

  for (const event of HOOK_EVENT_NAMES) {
    const current = hooks[event];
    if (current === undefined) {
      hooks[event] = [entry];
      installed.push(event);
      continue;
    }
    if (!Array.isArray(current)) {
      // Valor inesperado (no array) — no lo clobbereamos.
      skipped.push(event);
      continue;
    }
    if (current.some((e) => isOurEntry(e, paths.forwarderDest))) {
      alreadyPresent.push(event);
    } else {
      current.push(entry);
      installed.push(event);
    }
  }

  if (installed.length === 0) {
    // Nada que escribir: ya estaba todo. Evita reformatear el archivo
    // del usuario sin necesidad.
    return {
      status: 'unchanged',
      installed,
      alreadyPresent,
      skipped,
      ...base,
    };
  }

  const written = writeSettings(paths.settingsPath, settings, read.existed);
  if (!written.ok) {
    return {
      status: 'error',
      installed: [],
      alreadyPresent,
      skipped,
      message: written.message,
      ...base,
    };
  }

  return { status: 'installed', installed, alreadyPresent, skipped, ...base };
}

export interface UninstallResult {
  status: 'removed' | 'nothing' | 'error';
  removed: string[];
  message?: string;
}

/**
 * Quita SOLO nuestras entradas de cada evento (deja intactas las de
 * otros hooks) y borra el forwarder copiado. El archivo spool de
 * eventos se deja (es inofensivo y puede tener historial útil).
 */
export function uninstallHook(paths: HookPaths): UninstallResult {
  const read = readSettings(paths.settingsPath);
  if (!read.ok) {
    return { status: 'error', removed: [], message: read.message };
  }

  const hooks = asRecord(read.data.hooks);
  const removed: string[] = [];

  if (hooks) {
    for (const event of HOOK_EVENT_NAMES) {
      const current = hooks[event];
      if (!Array.isArray(current)) continue;
      const filtered = current.filter(
        (e) => !isOurEntry(e, paths.forwarderDest),
      );
      if (filtered.length !== current.length) removed.push(event);
      if (filtered.length === 0) {
        delete hooks[event];
      } else {
        hooks[event] = filtered;
      }
    }
  }

  // Borra el forwarder copiado (best-effort).
  try {
    fs.rmSync(paths.forwarderDest, { force: true });
  } catch {
    // Ignorado: que no se pueda borrar el script no debe abortar el
    // desregistro del settings.
  }

  if (removed.length === 0) {
    return { status: 'nothing', removed };
  }

  const written = writeSettings(paths.settingsPath, read.data, read.existed);
  if (!written.ok) {
    return { status: 'error', removed: [], message: written.message };
  }
  return { status: 'removed', removed };
}

/** True si nuestra entrada está presente en al menos un evento. */
export function isHookInstalled(paths: HookPaths): boolean {
  const read = readSettings(paths.settingsPath);
  if (!read.ok) return false;
  const hooks = asRecord(read.data.hooks);
  if (!hooks) return false;
  return HOOK_EVENT_NAMES.some((event) => {
    const current = hooks[event];
    return (
      Array.isArray(current) &&
      current.some((e) => isOurEntry(e, paths.forwarderDest))
    );
  });
}

// === IO helpers ===

type SettingsRecord = Record<string, unknown>;

type ReadResult =
  | { ok: true; data: SettingsRecord; existed: boolean }
  | { ok: false; message: string };

function readSettings(settingsPath: string): ReadResult {
  if (!fs.existsSync(settingsPath)) {
    return { ok: true, data: {}, existed: false };
  }
  let text: string;
  try {
    text = fs.readFileSync(settingsPath, 'utf8');
  } catch (err) {
    return { ok: false, message: `cannot read settings: ${errMsg(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Settings corrupto → ABORTAR. Preferimos no instalar a clobberear
    // la config del usuario con un objeto vacío.
    return {
      ok: false,
      message: `settings.json is not valid JSON; refusing to overwrite. Fix ${settingsPath} and retry.`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'settings.json root is not an object.' };
  }
  return { ok: true, data: parsed as SettingsRecord, existed: true };
}

type WriteResult = { ok: true } | { ok: false; message: string };

function writeSettings(
  settingsPath: string,
  data: SettingsRecord,
  backup: boolean,
): WriteResult {
  // Tmp único por proceso: dos extension hosts (multi-window) instalando
  // a la vez no pisan el mismo archivo temporal. Mismo patrón que
  // mcp/auto-register y mcp/claude-md-injector.
  const tmp = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    if (backup && fs.existsSync(settingsPath)) {
      fs.copyFileSync(settingsPath, settingsPath + BACKUP_SUFFIX);
    }
    // Escritura atómica: tmp en el mismo dir + rename. Evita dejar el
    // settings a medio escribir si el proceso muere a mitad.
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, settingsPath);
    return { ok: true };
  } catch (err) {
    // Limpia el tmp huérfano si quedó a medias — no dejar basura junto
    // al settings del usuario.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    return { ok: false, message: `cannot write settings: ${errMsg(err)}` };
  }
}

function asRecord(value: unknown): SettingsRecord | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as SettingsRecord;
  }
  return undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
