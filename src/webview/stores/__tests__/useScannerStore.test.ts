// @vitest-environment happy-dom

/* ================================================================
 * useScannerStore.test.ts — Tests del store Pinia del scanner.
 *
 * Cubre las 2 actions de hidratación + getters de dedup + counts.
 * El foco está en la regla "dedup live↔históricas": solo se
 * descartan sesiones `entrypoint=sdk-ts` con sessionId vivo; las
 * `claude-vscode` siempre aparecen aunque coincida sessionId.
 *
 * Decisiones de testing:
 *   - happy-dom como el resto de los stores Vue.
 *   - Pinia re-creado por test.
 * ================================================================ */

import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useScannerStore } from '../useScannerStore';
import type {
  ProjectFromDisk,
  SessionFromDisk,
} from '../../../shared/dashboard-protocol';

beforeEach(() => {
  setActivePinia(createPinia());
});

// === Builders ===

function makeProject(name: string, overrides: Partial<ProjectFromDisk> = {}): ProjectFromDisk {
  return {
    path: `/home/x/${name}`,
    name,
    branch: 'main',
    dirty: false,
    ...overrides,
  };
}

function makeSession(
  sessionId: string,
  project: string,
  overrides: Partial<SessionFromDisk> = {},
): SessionFromDisk {
  return {
    filePath: `/.claude/projects/${project}/${sessionId}.jsonl`,
    sessionId,
    cwd: `/home/x/${project}`,
    project,
    task: '',
    branch: 'main',
    firstPrompt: 'p',
    firstPromptFull: 'p (full)',
    startedAtIso: '2026-05-25T10:00:00Z',
    endedAtIso: '2026-05-25T10:05:00Z',
    status: 'done',
    entrypoint: 'claude-vscode',
    ...overrides,
  };
}

// ====================================================================
// === Tests ==========================================================
// ====================================================================

describe('useScannerStore / actions', () => {
  it('applyProjectsFromDisk replaces state + sets lastScanIso', () => {
    const store = useScannerStore();
    const projects = [makeProject('a'), makeProject('b')];
    store.applyProjectsFromDisk(projects, '2026-05-25T12:00:00Z');
    expect(store.projectsFromDisk.length).toBe(2);
    expect(store.lastScanIso).toBe('2026-05-25T12:00:00Z');
    // Snapshot copy: mutar el input no afecta el store.
    projects.push(makeProject('c'));
    expect(store.projectsFromDisk.length).toBe(2);
  });

  it('applySessionsFromDisk replaces state + sets lastScanIso', () => {
    const store = useScannerStore();
    store.applySessionsFromDisk([makeSession('s1', 'proj-a')], '2026-05-25T12:00:00Z');
    expect(store.sessionsFromDisk.length).toBe(1);
    expect(store.lastScanIso).toBe('2026-05-25T12:00:00Z');
  });
});

describe('useScannerStore / sessionsByProject', () => {
  it('groups sessions by project', () => {
    const store = useScannerStore();
    store.applySessionsFromDisk(
      [
        makeSession('s1', 'proj-a'),
        makeSession('s2', 'proj-a'),
        makeSession('s3', 'proj-b'),
      ],
      'iso',
    );
    expect(store.sessionsByProject.get('proj-a')?.length).toBe(2);
    expect(store.sessionsByProject.get('proj-b')?.length).toBe(1);
    expect(store.sessionsByProject.get('missing')).toBeUndefined();
  });
});

describe('useScannerStore / pastSessionsForProject (dedup)', () => {
  it('returns all sessions when no live sessionIds match', () => {
    const store = useScannerStore();
    store.applySessionsFromDisk(
      [
        makeSession('s1', 'proj-a', { entrypoint: 'sdk-ts' }),
        makeSession('s2', 'proj-a', { entrypoint: 'claude-vscode' }),
      ],
      'iso',
    );
    const past = store.pastSessionsForProject('proj-a', new Set());
    expect(past.map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('excludes sdk-ts sessions whose id matches a live agent', () => {
    const store = useScannerStore();
    store.applySessionsFromDisk(
      [
        makeSession('orch-1', 'proj-a', { entrypoint: 'sdk-ts' }),
        makeSession('s2', 'proj-a', { entrypoint: 'claude-vscode' }),
      ],
      'iso',
    );
    const past = store.pastSessionsForProject('proj-a', new Set(['orch-1']));
    expect(past.map((s) => s.sessionId)).toEqual(['s2']);
  });

  it('keeps claude-vscode sessions even if sessionId matches a live agent', () => {
    const store = useScannerStore();
    store.applySessionsFromDisk(
      [makeSession('shared-id', 'proj-a', { entrypoint: 'claude-vscode' })],
      'iso',
    );
    const past = store.pastSessionsForProject('proj-a', new Set(['shared-id']));
    expect(past.length).toBe(1);
  });

  it('returns empty for unknown project', () => {
    const store = useScannerStore();
    store.applySessionsFromDisk([makeSession('s1', 'proj-a')], 'iso');
    const past = store.pastSessionsForProject('nope', new Set());
    expect(past).toEqual([]);
  });
});

describe('useScannerStore / sessionCountFor', () => {
  it('counts sessions per project ignoring live dedup', () => {
    const store = useScannerStore();
    store.applySessionsFromDisk(
      [
        makeSession('s1', 'proj-a', { entrypoint: 'sdk-ts' }),
        makeSession('s2', 'proj-a', { entrypoint: 'claude-vscode' }),
        makeSession('s3', 'proj-b'),
      ],
      'iso',
    );
    expect(store.sessionCountFor('proj-a')).toBe(2);
    expect(store.sessionCountFor('proj-b')).toBe(1);
    expect(store.sessionCountFor('missing')).toBe(0);
  });
});

describe('useScannerStore / projectNamesFromDisk', () => {
  it('combines names from projects + sessions deduped', () => {
    const store = useScannerStore();
    store.applyProjectsFromDisk([makeProject('proj-a'), makeProject('proj-b')], 'iso');
    store.applySessionsFromDisk(
      [
        makeSession('s1', 'proj-a'),
        makeSession('s2', 'proj-c'), // solo en sessions
      ],
      'iso',
    );
    const names = Array.from(store.projectNamesFromDisk).sort();
    expect(names).toEqual(['proj-a', 'proj-b', 'proj-c']);
  });

  it('skips sessions whose project is empty', () => {
    const store = useScannerStore();
    store.applySessionsFromDisk([makeSession('s1', '')], 'iso');
    expect(Array.from(store.projectNamesFromDisk)).toEqual([]);
  });
});
