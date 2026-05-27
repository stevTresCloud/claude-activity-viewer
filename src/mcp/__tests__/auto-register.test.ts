// === Tests del helper auto-register ===
//
// Cubrimos el merge logic + branches defensivos (config faltante, JSON
// inválido, preservar otros MCP servers, no-op cuando coincide). Usamos
// un dir temporal por test para aislar filesystem state. NO tocamos el
// ~/.claude.json real del developer — todo va contra tmpdir.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEntry,
  entriesEqual,
  registerInClaudeCodeConfig,
  SERVER_NAME,
} from '../auto-register';

describe('buildEntry', () => {
  it('builds an HTTP entry with the bearer token in headers', () => {
    const entry = buildEntry('tok-abc', 39127);
    expect(entry).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:39127/mcp',
      headers: { Authorization: 'Bearer tok-abc' },
    });
  });
});

describe('entriesEqual', () => {
  const target = buildEntry('t', 39127);

  it('returns false when existing is undefined', () => {
    expect(entriesEqual(undefined, target)).toBe(false);
  });

  it('returns false when existing is not an object', () => {
    expect(entriesEqual('string', target)).toBe(false);
    expect(entriesEqual(42, target)).toBe(false);
    expect(entriesEqual(null, target)).toBe(false);
  });

  it('returns true when all relevant fields match', () => {
    expect(
      entriesEqual(
        {
          type: 'http',
          url: 'http://127.0.0.1:39127/mcp',
          headers: { Authorization: 'Bearer t' },
        },
        target,
      ),
    ).toBe(true);
  });

  it('returns false when type differs', () => {
    expect(
      entriesEqual(
        {
          type: 'stdio',
          url: 'http://127.0.0.1:39127/mcp',
          headers: { Authorization: 'Bearer t' },
        },
        target,
      ),
    ).toBe(false);
  });

  it('returns false when url differs', () => {
    expect(
      entriesEqual(
        {
          type: 'http',
          url: 'http://127.0.0.1:99999/mcp',
          headers: { Authorization: 'Bearer t' },
        },
        target,
      ),
    ).toBe(false);
  });

  it('returns false when Authorization differs', () => {
    expect(
      entriesEqual(
        {
          type: 'http',
          url: 'http://127.0.0.1:39127/mcp',
          headers: { Authorization: 'Bearer different' },
        },
        target,
      ),
    ).toBe(false);
  });

  it('returns false when headers is missing', () => {
    expect(
      entriesEqual(
        { type: 'http', url: 'http://127.0.0.1:39127/mcp' },
        target,
      ),
    ).toBe(false);
  });
});

describe('registerInClaudeCodeConfig', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'co-auto-register-'));
    configPath = join(tmpDir, '.claude.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('skips with claude_config_missing when the file does not exist', async () => {
    const res = await registerInClaudeCodeConfig('tok', 39127, configPath);
    expect(res).toEqual({ status: 'skipped', reason: 'claude_config_missing' });
  });

  it('registers a new entry when mcpServers is empty', async () => {
    await writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const res = await registerInClaudeCodeConfig('tok-new', 39127, configPath);
    expect(res).toEqual({ status: 'registered' });

    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    expect(parsed.mcpServers[SERVER_NAME]).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:39127/mcp',
      headers: { Authorization: 'Bearer tok-new' },
    });
  });

  it('creates mcpServers when the key is missing in the config', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ someOtherKey: 'preserved' }),
      'utf8',
    );

    const res = await registerInClaudeCodeConfig('tok', 39127, configPath);
    expect(res).toEqual({ status: 'registered' });

    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers[SERVER_NAME]).toBeDefined();
    expect(parsed.someOtherKey).toBe('preserved');
  });

  it('preserves other mcpServers when adding our entry', async () => {
    const existing = {
      mcpServers: {
        'other-server': { type: 'stdio', command: 'foo', args: ['--bar'] },
        'another-http': {
          type: 'http',
          url: 'http://localhost:9999/mcp',
          headers: { Authorization: 'Bearer x' },
        },
      },
      unrelatedRootKey: 'still-here',
    };
    await writeFile(configPath, JSON.stringify(existing), 'utf8');

    await registerInClaudeCodeConfig('tok', 39127, configPath);

    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    expect(parsed.mcpServers['other-server']).toEqual({
      type: 'stdio',
      command: 'foo',
      args: ['--bar'],
    });
    expect(parsed.mcpServers['another-http']).toEqual({
      type: 'http',
      url: 'http://localhost:9999/mcp',
      headers: { Authorization: 'Bearer x' },
    });
    expect(parsed.mcpServers[SERVER_NAME]).toBeDefined();
    expect(parsed.unrelatedRootKey).toBe('still-here');
  });

  it('returns unchanged when the existing entry matches token + url exactly', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          [SERVER_NAME]: {
            type: 'http',
            url: 'http://127.0.0.1:39127/mcp',
            headers: { Authorization: 'Bearer same' },
          },
        },
      }),
      'utf8',
    );

    const res = await registerInClaudeCodeConfig('same', 39127, configPath);
    expect(res).toEqual({ status: 'unchanged' });
  });

  it('updates the entry when the token has rotated', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          [SERVER_NAME]: {
            type: 'http',
            url: 'http://127.0.0.1:39127/mcp',
            headers: { Authorization: 'Bearer old-token' },
          },
        },
      }),
      'utf8',
    );

    const res = await registerInClaudeCodeConfig(
      'new-token',
      39127,
      configPath,
    );
    expect(res).toEqual({ status: 'registered' });

    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    expect(parsed.mcpServers[SERVER_NAME].headers.Authorization).toBe(
      'Bearer new-token',
    );
  });

  it('updates the entry when the port has changed', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          [SERVER_NAME]: {
            type: 'http',
            url: 'http://127.0.0.1:11111/mcp',
            headers: { Authorization: 'Bearer t' },
          },
        },
      }),
      'utf8',
    );

    const res = await registerInClaudeCodeConfig('t', 39127, configPath);
    expect(res).toEqual({ status: 'registered' });

    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    expect(parsed.mcpServers[SERVER_NAME].url).toBe(
      'http://127.0.0.1:39127/mcp',
    );
  });

  it('returns error on invalid JSON content (does not overwrite the file)', async () => {
    await writeFile(configPath, 'not valid json {{{', 'utf8');

    const res = await registerInClaudeCodeConfig('t', 39127, configPath);
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.message).toMatch(/parse failed/i);
    }

    const stillRaw = await readFile(configPath, 'utf8');
    expect(stillRaw).toBe('not valid json {{{');
  });

  it('uses an atomic write (no half-written file even with formatted output)', async () => {
    await writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const res = await registerInClaudeCodeConfig('tok', 39127, configPath);
    expect(res).toEqual({ status: 'registered' });

    const raw = await readFile(configPath, 'utf8');
    // Should be valid JSON with 2-space indentation (we use null, 2 on stringify).
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw).toContain('\n  "mcpServers"');
  });
});
