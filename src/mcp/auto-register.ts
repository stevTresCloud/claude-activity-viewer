// === Auto-register del MCP server en el config de Claude Code CLI ===
//
// El CLI Claude Code guarda su config en `~/.claude.json` con shape:
//   { mcpServers: { "<name>": { type, url, headers, ... }, ... }, ... }
//
// Sin este helper, el user tiene que copiar el `claude mcp add-json ...`
// que el plugin imprime al OutputChannel y pegarlo en una terminal externa
// — fricción real que mata adopción en plugins nuevos. Este helper hace
// el merge directo en el config, idempotente, atómico (temp + rename),
// preservando otros MCP servers que el user tenga registrados.
//
// Decisiones de diseño:
//   - SOLO escribimos si la entry no existe o difiere (no-op silencioso si
//     ya está registrada con el mismo token + url). Evita reescribir el
//     config en cada activate.
//   - Si `~/.claude.json` NO existe → `skipped` con razón. No creamos el
//     archivo porque sin Claude Code CLI instalado no tiene sentido.
//   - JSON parse falla → `error`. El user puede tener el config corrupto;
//     no lo sobreescribimos a ciegas.
//   - Atomic write: writeFile a temp + rename. fs.rename es atómico en el
//     mismo filesystem, así que el config nunca queda half-written aunque
//     el proceso muera entre las dos calls.
//   - NO removemos la entry en deactivate. El user puede querer mantener
//     el registro entre sessions; un comando palette explícito puede
//     limpiar si hace falta.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.claude.json');
export const SERVER_NAME = 'claude-orchestrator';

export interface McpHttpEntry {
  type: 'http';
  url: string;
  headers: { Authorization: string };
}

export interface ClaudeConfig {
  mcpServers?: Record<string, McpHttpEntry | Record<string, unknown>>;
  [otherKey: string]: unknown;
}

export type RegisterResult =
  | { status: 'registered' } // entry agregada o actualizada
  | { status: 'unchanged' } // ya estaba registrada con valores idénticos
  | { status: 'skipped'; reason: 'claude_config_missing' }
  | { status: 'error'; message: string };

export function buildEntry(token: string, port: number): McpHttpEntry {
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  };
}

// Compara entradas existente vs target. Si difieren en tipo, url, o
// Authorization, devuelve false → forzamos rewrite. La comparación es
// shallow sobre los 3 campos relevantes; otros campos opcionales que el
// CLI Claude Code agregue (timeout, etc.) NO los comparamos porque el
// user puede haberlos seteado a mano.
export function entriesEqual(
  existing: unknown,
  target: McpHttpEntry,
): boolean {
  if (!existing || typeof existing !== 'object') return false;
  const e = existing as Record<string, unknown>;
  if (e.type !== target.type) return false;
  if (e.url !== target.url) return false;
  const headers = e.headers as Record<string, unknown> | undefined;
  return headers?.Authorization === target.headers.Authorization;
}

export async function registerInClaudeCodeConfig(
  token: string,
  port: number,
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<RegisterResult> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { status: 'skipped', reason: 'claude_config_missing' };
    }
    return { status: 'error', message: `read failed: ${stringifyErr(err)}` };
  }

  let config: ClaudeConfig;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    return { status: 'error', message: `parse failed: ${stringifyErr(err)}` };
  }

  const target = buildEntry(token, port);
  const existing = config.mcpServers?.[SERVER_NAME];
  if (entriesEqual(existing, target)) {
    return { status: 'unchanged' };
  }

  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers[SERVER_NAME] = target;

  // Atomic write: temp file en el mismo dir (para que rename sea atómico)
  // + rename. Si el proceso muere entre writeFile y rename, el config
  // original queda intacto.
  const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf8');
    await fs.rename(tmpPath, configPath);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // best-effort cleanup; si el tmp no existía o no se puede borrar,
      // tampoco es crítico — el config original sigue intacto.
    }
    return { status: 'error', message: `write failed: ${stringifyErr(err)}` };
  }

  return { status: 'registered' };
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
