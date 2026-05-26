/* ================================================================
 * session-scanner.test.ts — Tests del parser JSONL de sesiones.
 *
 * Estrategia: fixtures reales en /tmp/co-test-claude-... con
 * archivos `.jsonl` sintéticos. El scanner lee streams con
 * readline, así que necesitamos archivos reales (no mocks de
 * readline) para ejercitar el parser end-to-end.
 *
 * Helpers locales:
 *   - `writeJsonl(file, lines)`: serializa cada línea como JSON +
 *     newline.
 *   - `deriveContextStub`: fake del derive del bridge — devuelve
 *     basename(cwd) como project, sin task.
 *
 * Test cases:
 *   - parse OK happy path con status=done (último result+success).
 *   - status=failed cuando último result tiene is_error=true.
 *   - status=failed cuando subtype ≠ success y no hay is_error.
 *   - status=interrupted cuando no hay terminal.
 *   - entrypoint capturado del header (claude-vscode vs sdk-ts).
 *   - JSONL malformado (línea no-JSON) → skip + sigue.
 *   - JSONL sin cwd → session ignorada.
 *   - cleanFirstPrompt strip de `<ide_*>...</ide_*>`.
 *   - truncate primer prompt a 80 chars con elipsis.
 *   - branch="HEAD" → reportada como vacío.
 *   - dedup por sessionId entre subfolders distintos.
 *   - extractUserText con array de blocks.
 *   - inferStatus expone los 3 estados.
 * ================================================================ */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  scanSessions,
  cleanFirstPrompt,
  extractUserText,
  extractToolUsePaths,
  inferStatus,
  sessionsInProjects,
  type ScanSessionsOptions,
} from '../session-scanner';

/**
 * Wrapper que descarta el cache result y devuelve solo el array
 * de sesiones. La mayoría de los tests del scanner no validan
 * comportamiento de cache, así que esto les permite seguir usando
 * el shape original `SessionFromDisk[]` sin cambios masivos.
 * Tests específicos del cache llaman `scanSessions` directo.
 */
async function scanSessionsList(
  opts: ScanSessionsOptions,
): Promise<SessionFromDisk[]> {
  const result = await scanSessions(opts);
  return result.sessions;
}
import type {
  ProjectFromDisk,
  SessionFromDisk,
} from '../../shared/dashboard-protocol';

// === Fixtures helpers ===

const fixtureDirs: string[] = [];

afterEach(() => {
  for (const d of fixtureDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  fixtureDirs.length = 0;
});

function makeClaudeProjectsDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'co-test-claude-'));
  fixtureDirs.push(d);
  return d;
}

function writeJsonl(filePath: string, lines: object[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

/**
 * Fake del derive del bridge: usa basename(cwd) como project,
 * sin task. Igual de puro y sin tocar `vscode`.
 */
function deriveContextStub(
  cwd: string,
): { project: string; task: string } {
  return { project: path.basename(cwd), task: '' };
}

/**
 * Fake con heurística v2: busca paths absolutos en prompt + signal.
 * Reemplaza la versión v1 con soporte para signalText.
 * Replica el comportamiento real para tests end-to-end.
 */
function deriveContextWithPromptStub(
  cwd: string,
  projectsRoot: string[],
  prompt?: string,
  signalText?: string,
): { project: string; task: string } {
  const haystack = [prompt, signalText].filter(Boolean).join('\n');
  if (haystack && projectsRoot.length > 0) {
    const regex = /(?:^|[\s(`"'])(\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(haystack)) !== null) {
      const candidate = m[1];
      for (const root of projectsRoot) {
        if (candidate.startsWith(root + '/')) {
          const rel = candidate.slice(root.length + 1);
          const segs = rel.split('/');
          if (segs[0]) {
            const project = segs[0];
            const task = segs[1] === 'tasks' && segs[2] ? segs[2] : '';
            return { project, task };
          }
        }
      }
    }
  }
  return { project: path.basename(cwd), task: '' };
}

// === Builder de eventos JSONL ===
//
// `headerLine` = primera línea con cwd+sessionId+entrypoint.
// `resultLine` = última línea opcional para inferir status.

interface HeaderInit {
  cwd: string;
  sessionId: string;
  gitBranch?: string;
  entrypoint?: string;
  timestamp?: string;
  userText?: string | object[]; // string o array de blocks
}

/**
 * Expande un id corto ("s1") a UUID canónico determinístico ("00000000-0000-0000-0000-...0001s1").
 * El parser nuevo rechaza sessionIds que no respeten el shape UUID.
 * Mantenemos ids cortos en los tests por legibilidad y dejamos que
 * el builder los normalice. Si ya viene un UUID válido se devuelve
 * tal cual; si trae un id ilegal a propósito (test de guard), también.
 */
function expandSessionId(raw: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return raw;
  }
  // Si parece "malicioso" (tiene caracteres no-hex/no-guion) lo
  // dejamos pasar — el test del guard depende de eso.
  if (!/^[a-z0-9-]+$/i.test(raw)) return raw;
  // Normalizamos para que distintos ids cortos produzcan UUIDs
  // distintos pero determinísticos.
  const padded = raw.padEnd(32, '0').slice(0, 32).replace(/[^0-9a-f]/gi, '0');
  return `${padded.slice(0, 8)}-${padded.slice(8, 12)}-${padded.slice(12, 16)}-${padded.slice(16, 20)}-${padded.slice(20, 32)}`;
}

function headerLine(init: HeaderInit): object {
  const content = typeof init.userText === 'string'
    ? [{ type: 'text', text: init.userText }]
    : init.userText ?? [{ type: 'text', text: 'hola' }];
  return {
    parentUuid: null,
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    timestamp: init.timestamp ?? '2026-05-25T10:00:00.000Z',
    sessionId: expandSessionId(init.sessionId),
    cwd: init.cwd,
    gitBranch: init.gitBranch ?? 'main',
    entrypoint: init.entrypoint ?? 'claude-vscode',
  };
}

function resultLine(
  init: { subtype?: string; is_error?: boolean; timestamp?: string },
): object {
  return {
    type: 'result',
    subtype: init.subtype ?? 'success',
    is_error: init.is_error ?? false,
    timestamp: init.timestamp ?? '2026-05-25T10:05:00.000Z',
  };
}

// ====================================================================
// === Tests del end-to-end scanSessions ==============================
// ====================================================================

describe('session-scanner / scanSessions', () => {
  it('exposes firstPrompt (80 chars) AND firstPromptFull (400 chars) from a long user message', async () => {
    // Repro del bug visible: el user activó expand pero las cards
    // se veían igual porque firstPrompt estaba capped a 80 chars
    // en el wire. Ahora firstPromptFull lleva hasta 400 chars.
    const root = makeClaudeProjectsDir();
    // Prompt de ~250 chars — más que el cap corto (80) y menos
    // que el largo (400). Debe quedar ENTERO en firstPromptFull
    // y truncado en firstPrompt.
    const longPrompt =
      'Continuamos con el PR #285 — Correcciones de observaciones, Fase 4 (cierre). ' +
      'Revisa el contexto del proyecto y la documentación de las fases previas. ' +
      'El objetivo es cerrar todas las observaciones antes del viernes.';
    writeJsonl(
      path.join(root, '-test/long-prompt.jsonl'),
      [
        headerLine({
          cwd: '/test',
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-777777777777',
          userText: longPrompt,
        }),
        resultLine({ subtype: 'success' }),
      ],
    );

    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });
    expect(result.length).toBe(1);
    const s = result[0];
    // firstPrompt está truncado con elipsis a 80 chars.
    expect(s.firstPrompt.length).toBe(80);
    expect(s.firstPrompt.endsWith('…')).toBe(true);
    // firstPromptFull preserva el texto completo (cabe en 400).
    expect(s.firstPromptFull.length).toBeGreaterThan(80);
    expect(s.firstPromptFull.endsWith('…')).toBe(false);
    expect(s.firstPromptFull).toContain('observaciones antes del viernes');
  });

  it('parses happy path JSONL into SessionFromDisk with status=done', async () => {
    const root = makeClaudeProjectsDir();
    const folder = path.join(root, '-home-trescloud-git19-my-proj');
    writeJsonl(path.join(folder, 'session-1.jsonl'), [
      { type: 'queue-operation', sessionId: 's1' },
      headerLine({
        cwd: '/home/trescloud/git19/my-proj',
        sessionId: 's1',
        entrypoint: 'claude-vscode',
        userText: 'Hello world implementar foo',
      }),
      resultLine({ subtype: 'success' }),
    ]);

    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: ['/home/trescloud/git19'],
      deriveContext: deriveContextStub,
    });

    expect(result.length).toBe(1);
    const s = result[0];
    expect(s.sessionId).toBe(expandSessionId('s1'));
    expect(s.cwd).toBe('/home/trescloud/git19/my-proj');
    expect(s.project).toBe('my-proj');
    expect(s.branch).toBe('main');
    expect(s.firstPrompt).toBe('Hello world implementar foo');
    expect(s.entrypoint).toBe('claude-vscode');
    expect(s.status).toBe('done');
    expect(s.startedAtIso).toBe('2026-05-25T10:00:00.000Z');
    expect(s.endedAtIso).toBe('2026-05-25T10:05:00.000Z');
  });

  it('reports status=failed when last result has is_error=true', async () => {
    const root = makeClaudeProjectsDir();
    writeJsonl(
      path.join(root, '-test/session-failed.jsonl'),
      [
        headerLine({ cwd: '/test', sessionId: 'sf', userText: 'bug' }),
        resultLine({ is_error: true }),
      ],
    );

    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });
    expect(result[0].status).toBe('failed');
  });

  it('reports status=failed when subtype is not success', async () => {
    const root = makeClaudeProjectsDir();
    writeJsonl(
      path.join(root, '-test/session-maxturns.jsonl'),
      [
        headerLine({ cwd: '/test', sessionId: 'smt', userText: 'long' }),
        resultLine({ subtype: 'error_max_turns', is_error: false }),
      ],
    );

    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });
    expect(result[0].status).toBe('failed');
  });

  it('reports status=interrupted when no result line', async () => {
    const root = makeClaudeProjectsDir();
    writeJsonl(
      path.join(root, '-test/session-int.jsonl'),
      [headerLine({ cwd: '/test', sessionId: 'si', userText: 'wip' })],
    );

    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });
    expect(result[0].status).toBe('interrupted');
  });

  it('skips malformed lines but keeps parsing', async () => {
    const root = makeClaudeProjectsDir();
    const file = path.join(root, '-test/session-corrupt.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Mezclamos línea no-JSON con válidas.
    fs.writeFileSync(
      file,
      'NOT JSON AT ALL\n' +
        JSON.stringify(
          headerLine({ cwd: '/test', sessionId: 'sc', userText: 'after garbage' }),
        ) +
        '\n' +
        'ALSO BROKEN\n' +
        JSON.stringify(resultLine({ subtype: 'success' })) +
        '\n',
    );

    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe(expandSessionId('sc'));
    expect(result[0].status).toBe('done');
  });

  it('returns no entry when JSONL lacks cwd or sessionId', async () => {
    const root = makeClaudeProjectsDir();
    writeJsonl(
      path.join(root, '-test/session-noheader.jsonl'),
      [
        { type: 'queue-operation', timestamp: '2026-05-25T10:00:00Z' },
        { type: 'system', text: 'something' },
      ],
    );

    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });
    expect(result.length).toBe(0);
  });

  it('detached branch ("HEAD") reported as empty string', async () => {
    const root = makeClaudeProjectsDir();
    writeJsonl(
      path.join(root, '-test/session-head.jsonl'),
      [
        headerLine({
          cwd: '/test',
          sessionId: 'sh',
          gitBranch: 'HEAD',
          userText: 'detached',
        }),
        resultLine({ subtype: 'success' }),
      ],
    );

    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });
    expect(result[0].branch).toBe('');
  });

  it('preserves entrypoint sdk-ts to enable dedup downstream', async () => {
    const root = makeClaudeProjectsDir();
    writeJsonl(
      path.join(root, '-test/session-sdk.jsonl'),
      [
        headerLine({
          cwd: '/test',
          sessionId: 'orch-1',
          entrypoint: 'sdk-ts',
          userText: 'mcp call',
        }),
        resultLine({ subtype: 'success' }),
      ],
    );

    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });
    expect(result[0].entrypoint).toBe('sdk-ts');
  });

  it('dedups sessions by sessionId across folders', async () => {
    const root = makeClaudeProjectsDir();
    writeJsonl(
      path.join(root, '-folder-a/session-dup.jsonl'),
      [
        headerLine({
          cwd: '/test/a',
          sessionId: 'dup-1',
          timestamp: '2026-05-25T10:00:00Z',
          userText: 'first',
        }),
      ],
    );
    writeJsonl(
      path.join(root, '-folder-b/session-dup.jsonl'),
      [
        headerLine({
          cwd: '/test/b',
          sessionId: 'dup-1',
          timestamp: '2026-05-25T11:00:00Z',
          userText: 'duplicate',
        }),
      ],
    );

    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe(expandSessionId('dup-1'));
  });

  it('returns [] and logs when claude projects dir does not exist', async () => {
    const missing = path.join(os.tmpdir(), 'co-test-missing-claude-' + Date.now());
    const lines: string[] = [];
    const result = await scanSessionsList({
      claudeProjectsDir: missing,
      projectsRoot: [],
      deriveContext: deriveContextStub,
      logger: { appendLine: (l) => lines.push(l) },
    });
    expect(result).toEqual([]);
    expect(lines.some((l) => l.includes('cannot read claude projects dir'))).toBe(true);
  });

  it('caps to 100 sessions per folder + logs truncated count', async () => {
    const root = makeClaudeProjectsDir();
    const folder = path.join(root, '-cap-test');
    for (let i = 0; i < 105; i++) {
      writeJsonl(path.join(folder, `s-${String(i).padStart(3, '0')}.jsonl`), [
        headerLine({
          cwd: '/test/cap',
          sessionId: `${'a'.repeat(8)}-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`,
          timestamp: `2026-05-25T10:${String(i).padStart(2, '0')}:00Z`,
          userText: `prompt ${i}`,
        }),
      ]);
    }
    const lines: string[] = [];
    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
      logger: { appendLine: (l) => lines.push(l) },
    });
    expect(result.length).toBe(100);
    expect(lines.some((l) => l.includes('truncated=5'))).toBe(true);
  });

  it('logs when a file has too many unparseable lines (corrupt)', async () => {
    const root = makeClaudeProjectsDir();
    const file = path.join(root, '-test/corrupt.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) lines.push('NOT JSON ' + i);
    lines.push(
      JSON.stringify(
        headerLine({
          cwd: '/test',
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userText: 'after garbage',
        }),
      ),
    );
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const logged: string[] = [];
    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
      logger: { appendLine: (l) => logged.push(l) },
    });
    expect(result.length).toBe(1);
    expect(logged.some((l) => l.includes('unparseable lines'))).toBe(true);
  });

  it('trims whitespace from gitBranch ("main\\n" → "main")', async () => {
    const root = makeClaudeProjectsDir();
    writeJsonl(
      path.join(root, '-test/branch-ws.jsonl'),
      [
        headerLine({
          cwd: '/test',
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-111111111111',
          gitBranch: '  feature/foo  \n',
          userText: 'ws branch',
        }),
        resultLine({ subtype: 'success' }),
      ],
    );
    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });
    expect(result[0].branch).toBe('feature/foo');
  });

  it('derives project from tool_use file_path when user prompts are conversational', async () => {
    // Caso real: "Continuamos con el PR #285 — Fase 4" como primer
    // prompt; el path real solo aparece en tool_use de Read/Edit.
    const root = makeClaudeProjectsDir();
    writeJsonl(
      path.join(root, '-home-trescloud-git18/conv.jsonl'),
      [
        headerLine({
          cwd: '/home/trescloud/git18',
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-666666666666',
          userText: 'Continuamos con el PR #285 — Correcciones, Fase 4',
        }),
        // Mensaje assistant con tool_use referenciando file_path del proyecto.
        {
          type: 'assistant',
          timestamp: '2026-05-25T10:01:00Z',
          message: {
            content: [
              { type: 'text', text: 'Voy a leer el archivo.' },
              {
                type: 'tool_use',
                name: 'Read',
                input: { file_path: '/home/trescloud/git18/docs/ecuadorian-hr18/main.py' },
              },
            ],
          },
        },
        resultLine({ subtype: 'success' }),
      ],
    );

    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: ['/home/trescloud/git18/docs'],
      deriveContext: deriveContextWithPromptStub,
    });
    expect(result.length).toBe(1);
    expect(result[0].project).toBe('ecuadorian-hr18');
  });

  it('derives project from first user prompt when cwd is generic (Trescloud workspace case)', async () => {
    // Repro del bug visible en smoke E2E: VS Code abre Claude Code
    // con cwd=workspace folder (~/git19/), pero el user trabaja en
    // ~/git19/docs/equipo-ya/. Sin la heurística, todas las
    // sesiones aparecen agrupadas bajo "git19".
    const root = makeClaudeProjectsDir();
    writeJsonl(
      path.join(root, '-home-trescloud-git19/session-x.jsonl'),
      [
        headerLine({
          cwd: '/home/trescloud/git19',
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-555555555555',
          userText:
            'En el módulo /home/trescloud/git19/docs/equipo-ya/tasks/hr18/main.py necesito ...',
        }),
        resultLine({ subtype: 'success' }),
      ],
    );

    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: ['/home/trescloud/git19/docs'],
      deriveContext: deriveContextWithPromptStub,
    });
    expect(result.length).toBe(1);
    expect(result[0].project).toBe('equipo-ya');
    expect(result[0].task).toBe('hr18');
  });

  it('caps bytes per file when parsing large jsonl (e.g. base64 screenshots)', async () => {
    const root = makeClaudeProjectsDir();
    const file = path.join(root, '-big/huge.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Header válido + N líneas gigantes (1KB cada una) que superen
    // el cap. El parser debe extraer el header al principio y
    // cortar antes de llegar al final del archivo.
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-555555555555';
    const lines: string[] = [
      JSON.stringify(
        headerLine({
          cwd: '/test/big',
          sessionId,
          userText: 'big session',
        }),
      ),
    ];
    // Genera ~512 KB de basura JSON válida (text blocks largos) —
    // debe activar el cap de 256 KB definido en el módulo.
    const blob = 'x'.repeat(1024);
    for (let i = 0; i < 600; i++) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-05-25T10:01:00.000Z',
          message: { content: [{ type: 'text', text: blob }] },
        }),
      );
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const fileSize = fs.statSync(file).size;
    expect(fileSize).toBeGreaterThan(500_000);

    const logged: string[] = [];
    const t0 = Date.now();
    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
      logger: { appendLine: (l) => logged.push(l) },
    });
    const elapsed = Date.now() - t0;

    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe(sessionId);
    expect(logged.some((l) => l.includes('truncated at'))).toBe(true);
    // Sanity check: 600 líneas grandes serializadas normalmente
    // toman ~30-50ms; el cap recorta antes así que esperamos <30ms
    // de tiempo de parseo. Threshold generoso para CI lento.
    expect(elapsed).toBeLessThan(200);
  });

  it('rejects sessions with malformed sessionId (security guard)', async () => {
    const root = makeClaudeProjectsDir();
    writeJsonl(
      path.join(root, '-test/bad-id.jsonl'),
      [
        headerLine({
          cwd: '/test',
          sessionId: 'foo; rm -rf ~',
          userText: 'malicious id',
        }),
      ],
    );
    const logged: string[] = [];
    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
      logger: { appendLine: (l) => logged.push(l) },
    });
    expect(result.length).toBe(0);
    expect(logged.some((l) => l.includes('unexpected sessionId shape'))).toBe(true);
  });

  it('sorts global result by endedAtIso descending', async () => {
    const root = makeClaudeProjectsDir();
    writeJsonl(
      path.join(root, '-a/s1.jsonl'),
      [
        headerLine({
          cwd: '/test/a',
          sessionId: 's1',
          timestamp: '2026-05-25T08:00:00Z',
          userText: 'old',
        }),
        resultLine({ timestamp: '2026-05-25T08:05:00Z', subtype: 'success' }),
      ],
    );
    writeJsonl(
      path.join(root, '-b/s2.jsonl'),
      [
        headerLine({
          cwd: '/test/b',
          sessionId: 's2',
          timestamp: '2026-05-25T12:00:00Z',
          userText: 'new',
        }),
        resultLine({ timestamp: '2026-05-25T12:05:00Z', subtype: 'success' }),
      ],
    );

    const result = await scanSessionsList({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });
    expect(result.map((s) => s.sessionId)).toEqual([
      expandSessionId('s2'),
      expandSessionId('s1'),
    ]);
  });
});

// ====================================================================
// === Tests de helpers puros =========================================
// ====================================================================

describe('session-scanner / cleanFirstPrompt', () => {
  it('strips <ide_selection>...</ide_selection> blocks', () => {
    const text =
      '<ide_selection>code here</ide_selection>Necesito implementar foo';
    expect(cleanFirstPrompt(text)).toBe('Necesito implementar foo');
  });

  it('strips multiple <ide_*> tags', () => {
    const text =
      '<ide_opened_file>x</ide_opened_file><ide_selection>y</ide_selection>Hola mundo';
    expect(cleanFirstPrompt(text)).toBe('Hola mundo');
  });

  it('returns empty string when everything is stripped', () => {
    expect(cleanFirstPrompt('<ide_selection>foo</ide_selection>')).toBe('');
  });

  it('truncates to 80 chars with ellipsis', () => {
    const long = 'a'.repeat(120);
    const out = cleanFirstPrompt(long);
    expect(out.length).toBe(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('collapses whitespace into single spaces', () => {
    expect(cleanFirstPrompt('hola    mundo\n\totra')).toBe('hola mundo otra');
  });
});

describe('session-scanner / extractUserText', () => {
  it('extracts text from array of text blocks', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'image', source: {} },
      { type: 'text', text: 'second' },
    ];
    expect(extractUserText(content)).toBe('first second');
  });

  it('returns string content as-is', () => {
    expect(extractUserText('plain text')).toBe('plain text');
  });

  it('returns null when content has no text blocks', () => {
    expect(extractUserText([{ type: 'image', source: {} }])).toBe(null);
  });

  it('returns null for non-array non-string', () => {
    expect(extractUserText(null)).toBe(null);
    expect(extractUserText(undefined)).toBe(null);
    expect(extractUserText(42)).toBe(null);
  });
});

describe('session-scanner / inferStatus', () => {
  it('returns interrupted when no terminal', () => {
    expect(inferStatus(null)).toBe('interrupted');
  });

  it('returns done on success result', () => {
    expect(inferStatus({ type: 'result', subtype: 'success' })).toBe('done');
  });

  it('returns failed when is_error is true', () => {
    expect(
      inferStatus({ type: 'result', subtype: 'success', is_error: true }),
    ).toBe('failed');
  });

  it('returns failed on non-success subtype', () => {
    expect(inferStatus({ type: 'result', subtype: 'error_max_turns' })).toBe(
      'failed',
    );
  });
});

describe('session-scanner / incremental cache', () => {
  it('reusa entries del cache cuando mtime no cambió', async () => {
    const root = makeClaudeProjectsDir();
    const filePath = path.join(root, '-test/a.jsonl');
    writeJsonl(filePath, [
      headerLine({
        cwd: '/test',
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-cache11111111',
        userText: 'cached session',
      }),
      resultLine({ subtype: 'success' }),
    ]);

    // Primer scan: sin cache, todo se re-parsea.
    const first = await scanSessions({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });
    expect(first.stats.reparsed).toBe(1);
    expect(first.stats.reusedFromCache).toBe(0);
    expect(first.nextCache.size).toBe(1);

    // Segundo scan con el cache del primero: hit, no se re-parsea.
    const second = await scanSessions({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
      cache: first.nextCache,
    });
    expect(second.stats.reusedFromCache).toBe(1);
    expect(second.stats.reparsed).toBe(0);
    expect(second.sessions[0].sessionId).toBe(first.sessions[0].sessionId);
  });

  it('re-parsea cuando la mtime del archivo cambió', async () => {
    const root = makeClaudeProjectsDir();
    const filePath = path.join(root, '-test/b.jsonl');
    writeJsonl(filePath, [
      headerLine({
        cwd: '/test',
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-cache22222222',
        userText: 'v1',
      }),
    ]);

    const first = await scanSessions({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });

    // Mutamos el archivo + futureamos su mtime para forzar invalidación.
    writeJsonl(filePath, [
      headerLine({
        cwd: '/test',
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-cache22222222',
        userText: 'v2 updated',
      }),
      resultLine({ subtype: 'success' }),
    ]);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(filePath, future, future);

    const second = await scanSessions({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
      cache: first.nextCache,
    });
    expect(second.stats.reparsed).toBe(1);
    expect(second.stats.reusedFromCache).toBe(0);
    expect(second.sessions[0].firstPrompt).toBe('v2 updated');
  });

  it('limpia entries del cache cuyo archivo fue borrado', async () => {
    const root = makeClaudeProjectsDir();
    const filePath = path.join(root, '-test/ephemeral.jsonl');
    writeJsonl(filePath, [
      headerLine({
        cwd: '/test',
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-cache33333333',
        userText: 'temp',
      }),
    ]);

    const first = await scanSessions({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });
    expect(first.nextCache.size).toBe(1);

    // Borramos el archivo y re-escaneamos con el cache del primer
    // run — la entry debe desaparecer del nextCache.
    fs.unlinkSync(filePath);
    const second = await scanSessions({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
      cache: first.nextCache,
    });
    expect(second.sessions.length).toBe(0);
    expect(second.nextCache.size).toBe(0);
    expect(second.stats.cleanedUp).toBe(1);
  });

  it('cache vacío en primera invocación = comportamiento idéntico a sin cache', async () => {
    const root = makeClaudeProjectsDir();
    writeJsonl(path.join(root, '-test/c.jsonl'), [
      headerLine({
        cwd: '/test',
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-cache44444444',
        userText: 'fresh',
      }),
      resultLine({ subtype: 'success' }),
    ]);

    const withEmptyCache = await scanSessions({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
      cache: new Map(),
    });
    const withoutCache = await scanSessions({
      claudeProjectsDir: root,
      projectsRoot: [],
      deriveContext: deriveContextStub,
    });
    expect(withEmptyCache.sessions.map((s) => s.sessionId)).toEqual(
      withoutCache.sessions.map((s) => s.sessionId),
    );
    expect(withEmptyCache.stats.reparsed).toBe(withoutCache.stats.reparsed);
  });
});

describe('session-scanner / extractToolUsePaths', () => {
  it('extrae file_path/path/notebook_path/command de bloques tool_use', () => {
    const content = [
      { type: 'text', text: 'voy a leer' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/abs/x.py' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'cat /abs/y.sh' } },
      { type: 'tool_use', name: 'NotebookRead', input: { notebook_path: '/abs/n.ipynb' } },
    ];
    expect(extractToolUsePaths(content)).toEqual([
      '/abs/x.py',
      'cat /abs/y.sh',
      '/abs/n.ipynb',
    ]);
  });

  it('ignora bloques no-tool_use', () => {
    const content = [
      { type: 'text', text: '/path/in/text/no/cuenta' },
      { type: 'image', source: {} },
    ];
    expect(extractToolUsePaths(content)).toEqual([]);
  });

  it('limita a 3 paths por bloque para no inflar', () => {
    const content = [
      {
        type: 'tool_use',
        name: 'Multi',
        input: {
          file_path: '/a',
          notebook_path: '/b',
          path: '/c',
          command: '/d',
        },
      },
    ];
    // PATH_KEYS itera file_path, notebook_path, path, command —
    // se queda con los 3 primeros.
    const out = extractToolUsePaths(content);
    expect(out).toHaveLength(3);
    expect(out).toEqual(['/a', '/b', '/c']);
  });

  it('devuelve [] cuando content no es array', () => {
    expect(extractToolUsePaths(null)).toEqual([]);
    expect(extractToolUsePaths('foo')).toEqual([]);
    expect(extractToolUsePaths(undefined)).toEqual([]);
  });
});

describe('session-scanner / sessionsInProjects', () => {
  it('returns all sessions when projects list is empty (no filter)', () => {
    const sessions: SessionFromDisk[] = [
      {
        filePath: 'f',
        sessionId: 's',
        cwd: '/anywhere',
        project: 'x',
        task: '',
        branch: 'main',
        firstPrompt: 'p',
    firstPromptFull: 'p (full)',
        startedAtIso: '',
        endedAtIso: '',
        status: 'done',
        entrypoint: 'cli',
      },
    ];
    expect(sessionsInProjects(sessions, [])).toEqual(sessions);
  });

  it('filters sessions whose cwd is inside any project path', () => {
    const projects: ProjectFromDisk[] = [
      { path: '/home/x/proj', name: 'proj', branch: 'main', dirty: false },
    ];
    const sessions: SessionFromDisk[] = [
      {
        filePath: 'f1',
        sessionId: 'in',
        cwd: '/home/x/proj/tasks/t1',
        project: 'proj',
        task: 't1',
        branch: 'main',
        firstPrompt: 'p',
    firstPromptFull: 'p (full)',
        startedAtIso: '',
        endedAtIso: '',
        status: 'done',
        entrypoint: 'cli',
      },
      {
        filePath: 'f2',
        sessionId: 'out',
        cwd: '/home/x/other',
        project: 'other',
        task: '',
        branch: 'main',
        firstPrompt: 'p',
    firstPromptFull: 'p (full)',
        startedAtIso: '',
        endedAtIso: '',
        status: 'done',
        entrypoint: 'cli',
      },
    ];
    const filtered = sessionsInProjects(sessions, projects);
    expect(filtered.map((s) => s.sessionId)).toEqual(['in']);
  });
});
