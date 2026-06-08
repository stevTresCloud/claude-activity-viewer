// === Tests del installer de hooks ===
//
// Todo contra un tmpdir: NUNCA tocamos el ~/.claude real. Cubrimos
// install idempotente, preservación de hooks de terceros (pixel-agents),
// uninstall quirúrgico, settings ausente/corrupto, y el backup.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHookEntry,
  defaultHookPaths,
  installHook,
  isHookInstalled,
  uninstallHook,
  type HookPaths,
} from '../hook-installer';
import { HOOK_EVENT_NAMES } from '../hook-events';

let dir: string;
let paths: HookPaths;
let forwarderSource: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ingester-install-'));
  const home = join(dir, 'home');
  fs.mkdirSync(join(home, '.claude'), { recursive: true });
  paths = defaultHookPaths(home);
  // Forwarder "bundleado" simulado.
  forwarderSource = join(dir, 'activity-viewer-hook.cjs');
  fs.writeFileSync(forwarderSource, '// forwarder stub\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readSettings(): Record<string, any> {
  return JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
}

/** Entrada de hook de un tercero (pixel-agents) para verificar que la preservamos. */
function pixelEntry() {
  return {
    matcher: '',
    hooks: [{ type: 'command', command: 'node "/home/u/.pixel-agents/hooks/claude-hook.js"', timeout: 5 }],
  };
}

describe('installHook', () => {
  it('installs our entry into all 7 events and copies the forwarder', () => {
    const result = installHook({ forwarderSource, paths });
    expect(result.status).toBe('installed');
    expect(result.installed.sort()).toEqual([...HOOK_EVENT_NAMES].sort());
    expect(fs.existsSync(paths.forwarderDest)).toBe(true);

    const settings = readSettings();
    for (const event of HOOK_EVENT_NAMES) {
      const arr = settings.hooks[event];
      expect(Array.isArray(arr)).toBe(true);
      expect(
        arr.some((e: any) =>
          e.hooks?.some((h: any) => h.command.includes(paths.forwarderDest)),
        ),
      ).toBe(true);
    }
  });

  it('injects the spool path into the installed command (SSoT)', () => {
    installHook({ forwarderSource, paths });
    const cmd = readSettings().hooks.SubagentStart[0].hooks[0].command;
    expect(cmd).toContain(paths.forwarderDest);
    expect(cmd).toContain(paths.eventsFile);
  });

  it('is idempotent: a second install is a no-op (unchanged)', () => {
    installHook({ forwarderSource, paths });
    const second = installHook({ forwarderSource, paths });
    expect(second.status).toBe('unchanged');
    expect(second.alreadyPresent.sort()).toEqual([...HOOK_EVENT_NAMES].sort());

    // No duplicó: cada evento sigue con UNA sola entrada nuestra.
    const settings = readSettings();
    for (const event of HOOK_EVENT_NAMES) {
      const ours = settings.hooks[event].filter((e: any) =>
        e.hooks?.some((h: any) => h.command.includes(paths.forwarderDest)),
      );
      expect(ours).toHaveLength(1);
    }
  });

  it('preserves third-party hook entries (pixel-agents) on the same events', () => {
    // settings.json pre-existente con un hook de pixel-agents en Stop.
    fs.writeFileSync(
      paths.settingsPath,
      JSON.stringify({ hooks: { Stop: [pixelEntry()] }, otherKey: 42 }, null, 2),
    );
    installHook({ forwarderSource, paths });

    const settings = readSettings();
    // El otro top-level key sobrevive.
    expect(settings.otherKey).toBe(42);
    // Stop ahora tiene AMBOS: pixel-agents + el nuestro.
    const stop = settings.hooks.Stop;
    expect(stop).toHaveLength(2);
    expect(
      stop.some((e: any) => e.hooks[0].command.includes('.pixel-agents')),
    ).toBe(true);
    expect(
      stop.some((e: any) => e.hooks[0].command.includes(paths.forwarderDest)),
    ).toBe(true);
  });

  it('writes a backup before modifying an existing settings.json', () => {
    fs.writeFileSync(paths.settingsPath, JSON.stringify({ hooks: {} }));
    installHook({ forwarderSource, paths });
    expect(fs.existsSync(paths.settingsPath + '.claude-activity-viewer.bak')).toBe(true);
  });

  it('creates settings.json when none exists', () => {
    rmSync(paths.settingsPath, { force: true });
    const result = installHook({ forwarderSource, paths });
    expect(result.status).toBe('installed');
    expect(fs.existsSync(paths.settingsPath)).toBe(true);
  });

  it('aborts (error) instead of clobbering a corrupt settings.json', () => {
    fs.writeFileSync(paths.settingsPath, '{ this is not json ');
    const result = installHook({ forwarderSource, paths });
    expect(result.status).toBe('error');
    // El archivo corrupto queda intacto (no lo sobreescribimos).
    expect(fs.readFileSync(paths.settingsPath, 'utf8')).toBe('{ this is not json ');
  });

  it('skips an event whose hooks value is not an array', () => {
    fs.writeFileSync(
      paths.settingsPath,
      JSON.stringify({ hooks: { Stop: 'weird-non-array' } }),
    );
    const result = installHook({ forwarderSource, paths });
    expect(result.skipped).toContain('Stop');
    // No clobbereamos el valor inesperado.
    expect(readSettings().hooks.Stop).toBe('weird-non-array');
  });
});

describe('isHookInstalled', () => {
  it('is false before install and true after', () => {
    expect(isHookInstalled(paths)).toBe(false);
    installHook({ forwarderSource, paths });
    expect(isHookInstalled(paths)).toBe(true);
  });
});

describe('uninstallHook', () => {
  it('removes only our entries and leaves third-party hooks intact', () => {
    fs.writeFileSync(
      paths.settingsPath,
      JSON.stringify({ hooks: { Stop: [pixelEntry()] } }, null, 2),
    );
    installHook({ forwarderSource, paths });

    const result = uninstallHook(paths);
    expect(result.status).toBe('removed');

    const settings = readSettings();
    // Stop conserva pixel-agents, sin la nuestra.
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('.pixel-agents');
    // Eventos que solo teníamos nosotros quedan vacíos → key borrada.
    expect(settings.hooks.SubagentStart).toBeUndefined();
    // El forwarder copiado se borró.
    expect(fs.existsSync(paths.forwarderDest)).toBe(false);
  });

  it('returns nothing when there is no settings file', () => {
    rmSync(paths.settingsPath, { force: true });
    expect(uninstallHook(paths).status).toBe('nothing');
  });

  it('round-trips: install then uninstall leaves no trace in settings', () => {
    fs.writeFileSync(paths.settingsPath, JSON.stringify({ hooks: {} }));
    installHook({ forwarderSource, paths });
    uninstallHook(paths);
    expect(isHookInstalled(paths)).toBe(false);
  });
});

describe('buildHookEntry', () => {
  it('builds a command entry passing the spool path to the forwarder', () => {
    const entry = buildHookEntry('/x/hook.cjs', '/x/events.jsonl');
    expect(entry).toEqual({
      matcher: '',
      hooks: [
        { type: 'command', command: 'node "/x/hook.cjs" "/x/events.jsonl"', timeout: 5 },
      ],
    });
  });
});
