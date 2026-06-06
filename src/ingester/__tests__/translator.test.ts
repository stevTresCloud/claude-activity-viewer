// === Tests del translator hook → eventos del store ===
//
// Reloj y context-deriver inyectados → duraciones reproducibles y sin
// tocar git/disco. Cubre happy path por evento, el lifecycle completo,
// y los guards defensivos (lazy-create, start duplicado, eventos post
// terminal, eventos de sesión sin agent_id).

import { describe, expect, it } from 'vitest';
import { HookTranslator } from '../translator';
import { parseHookEvent, type HookEvent } from '../hook-events';
import type { DashboardEventToWebview } from '../../shared/dashboard-protocol';

/** Pasa el raw por el validador real para que las fixtures sean fieles. */
function ev(raw: unknown): HookEvent {
  const r = parseHookEvent(raw);
  if (!r.ok) throw new Error(`fixture inválida: ${r.reason}`);
  return r.event;
}

function makeTranslator() {
  let clock = 1000;
  const translator = new HookTranslator({
    deriveContext: (cwd: string) => ({
      project: cwd ? `proj@${cwd}` : 'unknown',
      task: '',
      branch: 'main',
    }),
    now: () => clock,
  });
  return {
    translator,
    setNow: (n: number) => {
      clock = n;
    },
    advance: (d: number) => {
      clock += d;
    },
  };
}

function typesOf(events: DashboardEventToWebview[]): string[] {
  return events.map((e) => e.type);
}

describe('SubagentStart', () => {
  it('emits a single agent_created with a derived snapshot', () => {
    const { translator } = makeTranslator();
    const out = translator.translate(
      ev({
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-abcdef12',
        agent_type: 'Explore',
        session_id: 's-1',
        cwd: '/home/u/proj',
      }),
    );
    expect(typesOf(out)).toEqual(['agent_created']);
    const created = out[0];
    if (created.type !== 'agent_created') throw new Error('unreachable');
    expect(created.agent).toMatchObject({
      id: 'agent-abcdef12',
      name: 'Explore',
      status: 'running',
      project: 'proj@/home/u/proj',
      branch: 'main',
      batchId: 's-1',
      sessionId: 's-1',
      elapsedMs: 0,
    });
    expect(created.agent.startedAtIso).toBe(new Date(1000).toISOString());
  });

  it('falls back to a derived name when agent_type is absent', () => {
    const { translator } = makeTranslator();
    const out = translator.translate(
      ev({ hook_event_name: 'SubagentStart', agent_id: 'abcdef123456' }),
    );
    const created = out[0];
    if (created.type !== 'agent_created') throw new Error('unreachable');
    expect(created.agent.name).toBe('agent-abcdef12');
  });

  it('is idempotent: a duplicate start emits nothing', () => {
    const { translator } = makeTranslator();
    const start = ev({ hook_event_name: 'SubagentStart', agent_id: 'a-1' });
    expect(translator.translate(start)).toHaveLength(1);
    expect(translator.translate(start)).toEqual([]);
  });
});

describe('PreToolUse', () => {
  it('emits status_changed (currentTool + elapsed) and a tool_use log', () => {
    const { translator, advance } = makeTranslator();
    translator.translate(
      ev({ hook_event_name: 'SubagentStart', agent_id: 'a-1', cwd: '/p' }),
    );
    advance(500);
    const out = translator.translate(
      ev({
        hook_event_name: 'PreToolUse',
        agent_id: 'a-1',
        tool_name: 'Read',
        tool_input: { file_path: '/x' },
      }),
    );
    expect(typesOf(out)).toEqual(['agent_status_changed', 'agent_log']);
    const status = out[0];
    const log = out[1];
    if (status.type !== 'agent_status_changed') throw new Error('unreachable');
    if (log.type !== 'agent_log') throw new Error('unreachable');
    expect(status.status).toBe('running');
    expect(status.metadata).toMatchObject({ currentTool: 'Read', elapsedMs: 500 });
    expect(log.entry).toMatchObject({
      kind: 'tool_use',
      name: 'Read',
      input: { file_path: '/x' },
    });
  });

  it('ignores PreToolUse from the main session (no agent_id)', () => {
    const { translator } = makeTranslator();
    const out = translator.translate(
      ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
    );
    expect(out).toEqual([]);
  });

  it('lazy-creates an agent when the first event has no prior start', () => {
    const { translator } = makeTranslator();
    const out = translator.translate(
      ev({
        hook_event_name: 'PreToolUse',
        agent_id: 'late-9999',
        tool_name: 'Glob',
        cwd: '/p',
      }),
    );
    // agent_created precede al status + log.
    expect(typesOf(out)).toEqual([
      'agent_created',
      'agent_status_changed',
      'agent_log',
    ]);
    const created = out[0];
    if (created.type !== 'agent_created') throw new Error('unreachable');
    // name = `agent-${agent_id.slice(0, 8)}` → 'late-9999'.slice(0,8)='late-999'.
    expect(created.agent.name).toBe('agent-late-999');
  });
});

describe('PostToolUse', () => {
  it('emits a tool_result log and a status update', () => {
    const { translator } = makeTranslator();
    translator.translate(ev({ hook_event_name: 'SubagentStart', agent_id: 'a-1' }));
    const out = translator.translate(
      ev({
        hook_event_name: 'PostToolUse',
        agent_id: 'a-1',
        tool_name: 'Read',
        tool_response: { content: 'hello' },
        tool_use_id: 'tu-7',
        duration_ms: 12,
      }),
    );
    expect(typesOf(out)).toEqual(['agent_log', 'agent_status_changed']);
    const log = out[0];
    if (log.type !== 'agent_log') throw new Error('unreachable');
    expect(log.entry).toMatchObject({
      kind: 'tool_result',
      isError: false,
      toolUseId: 'tu-7',
    });
    expect(log.entry.result).toContain('hello');
  });

  it('detects tool errors via is_error', () => {
    const { translator } = makeTranslator();
    translator.translate(ev({ hook_event_name: 'SubagentStart', agent_id: 'a-1' }));
    const out = translator.translate(
      ev({
        hook_event_name: 'PostToolUse',
        agent_id: 'a-1',
        tool_name: 'Bash',
        tool_response: { is_error: true, error: 'boom' },
      }),
    );
    const log = out[0];
    if (log.type !== 'agent_log') throw new Error('unreachable');
    expect(log.entry.isError).toBe(true);
  });

  it('clears currentTool when the tool finishes', () => {
    const { translator } = makeTranslator();
    translator.translate(ev({ hook_event_name: 'SubagentStart', agent_id: 'a-1' }));
    translator.translate(
      ev({ hook_event_name: 'PreToolUse', agent_id: 'a-1', tool_name: 'Read' }),
    );
    const out = translator.translate(
      ev({
        hook_event_name: 'PostToolUse',
        agent_id: 'a-1',
        tool_name: 'Read',
        tool_response: 'ok',
      }),
    );
    const status = out[1];
    if (status.type !== 'agent_status_changed') throw new Error('unreachable');
    // '' (falsy) → la UI esconde la línea del tool entre tool y tool.
    expect(status.metadata?.currentTool).toBe('');
  });
});

describe('lastActivityIso (liveness)', () => {
  it('stamps lastActivityIso on the created snapshot and on each event', () => {
    const { translator, setNow } = makeTranslator();
    setNow(1000);
    const createdOut = translator.translate(
      ev({ hook_event_name: 'SubagentStart', agent_id: 'a-1' }),
    );
    const created = createdOut[0];
    if (created.type !== 'agent_created') throw new Error('unreachable');
    expect(created.agent.lastActivityIso).toBe(new Date(1000).toISOString());

    setNow(2500);
    const preOut = translator.translate(
      ev({ hook_event_name: 'PreToolUse', agent_id: 'a-1', tool_name: 'Read' }),
    );
    const status = preOut[0];
    if (status.type !== 'agent_status_changed') throw new Error('unreachable');
    expect(status.metadata?.lastActivityIso).toBe(new Date(2500).toISOString());
  });
});

describe('SubagentStop', () => {
  it('emits status_changed(done) + agent_completed with duration', () => {
    const { translator, setNow } = makeTranslator();
    setNow(1000);
    translator.translate(ev({ hook_event_name: 'SubagentStart', agent_id: 'a-1' }));
    setNow(4000);
    const out = translator.translate(
      ev({
        hook_event_name: 'SubagentStop',
        agent_id: 'a-1',
        last_assistant_message: 'done deal',
      }),
    );
    expect(typesOf(out)).toEqual(['agent_status_changed', 'agent_completed']);
    const status = out[0];
    const completed = out[1];
    if (status.type !== 'agent_status_changed') throw new Error('unreachable');
    if (completed.type !== 'agent_completed') throw new Error('unreachable');
    expect(status.status).toBe('done');
    expect(status.metadata).toMatchObject({ durationMs: 3000 });
    expect(completed.result).toEqual({
      status: 'done',
      durationMs: 3000,
      tokensUsed: 0,
    });
  });

  it('lazy-creates then closes an agent that was never started', () => {
    const { translator } = makeTranslator();
    const out = translator.translate(
      ev({ hook_event_name: 'SubagentStop', agent_id: 'ghost-1' }),
    );
    expect(typesOf(out)).toEqual([
      'agent_created',
      'agent_status_changed',
      'agent_completed',
    ]);
  });

  it('omits durationMs when Stop is the first event seen (no observed start)', () => {
    const { translator, setNow } = makeTranslator();
    setNow(5000);
    const out = translator.translate(
      ev({ hook_event_name: 'SubagentStop', agent_id: 'ghost-1' }),
    );
    const status = out[1];
    const completed = out[2];
    if (status.type !== 'agent_status_changed') throw new Error('unreachable');
    if (completed.type !== 'agent_completed') throw new Error('unreachable');
    // completedAtIso sí lo sabemos (es ahora); durationMs NO (no vimos el
    // arranque) → se omite en vez de mentir con ~0.
    expect(status.metadata?.completedAtIso).toBe(new Date(5000).toISOString());
    expect(status.metadata?.durationMs).toBeUndefined();
    expect(status.metadata?.elapsedMs).toBeUndefined();
    expect(completed.result.durationMs).toBeUndefined();
  });

  it('keeps durationMs when the start was observed', () => {
    const { translator, setNow } = makeTranslator();
    setNow(1000);
    translator.translate(ev({ hook_event_name: 'SubagentStart', agent_id: 'a-1' }));
    setNow(4000);
    const out = translator.translate(
      ev({ hook_event_name: 'SubagentStop', agent_id: 'a-1' }),
    );
    const completed = out[1];
    if (completed.type !== 'agent_completed') throw new Error('unreachable');
    expect(completed.result.durationMs).toBe(3000);
  });

  it('preserves session_id when lazy-creating from SubagentStop', () => {
    const { translator } = makeTranslator();
    const out = translator.translate(
      ev({ hook_event_name: 'SubagentStop', agent_id: 'g-1', session_id: 'sess-9' }),
    );
    const created = out[0];
    if (created.type !== 'agent_created') throw new Error('unreachable');
    expect(created.agent.sessionId).toBe('sess-9');
    expect(created.agent.batchId).toBe('sess-9');
  });

  it('ignores events after an agent is terminal', () => {
    const { translator } = makeTranslator();
    translator.translate(ev({ hook_event_name: 'SubagentStart', agent_id: 'a-1' }));
    translator.translate(ev({ hook_event_name: 'SubagentStop', agent_id: 'a-1' }));
    // Stop duplicado.
    expect(
      translator.translate(ev({ hook_event_name: 'SubagentStop', agent_id: 'a-1' })),
    ).toEqual([]);
    // Tool tardío.
    expect(
      translator.translate(
        ev({ hook_event_name: 'PreToolUse', agent_id: 'a-1', tool_name: 'Read' }),
      ),
    ).toEqual([]);
  });
});

describe('session-level events', () => {
  it('Stop / SessionStart / SessionEnd produce no store events in F1', () => {
    const { translator } = makeTranslator();
    expect(translator.translate(ev({ hook_event_name: 'Stop' }))).toEqual([]);
    expect(
      translator.translate(ev({ hook_event_name: 'SessionStart', source: 'startup' })),
    ).toEqual([]);
    expect(
      translator.translate(ev({ hook_event_name: 'SessionEnd', reason: 'clear' })),
    ).toEqual([]);
  });
});

describe('full lifecycle + transcript pointers', () => {
  it('threads start → pre → post → stop coherently', () => {
    const { translator, setNow } = makeTranslator();
    setNow(0);
    const all: string[] = [];
    const push = (e: DashboardEventToWebview[]) => all.push(...typesOf(e));

    push(
      translator.translate(
        ev({
          hook_event_name: 'SubagentStart',
          agent_id: 'a-1',
          agent_type: 'Plan',
          cwd: '/p',
          transcript_path: '/tmp/s.jsonl',
        }),
      ),
    );
    setNow(100);
    push(
      translator.translate(
        ev({ hook_event_name: 'PreToolUse', agent_id: 'a-1', tool_name: 'Read' }),
      ),
    );
    setNow(150);
    push(
      translator.translate(
        ev({
          hook_event_name: 'PostToolUse',
          agent_id: 'a-1',
          tool_name: 'Read',
          tool_response: 'ok',
        }),
      ),
    );
    expect(translator.getTranscriptPath('a-1')).toBe('/tmp/s.jsonl');

    setNow(900);
    push(
      translator.translate(
        ev({
          hook_event_name: 'SubagentStop',
          agent_id: 'a-1',
          agent_transcript_path: '/tmp/agent.jsonl',
        }),
      ),
    );

    expect(all).toEqual([
      'agent_created',
      'agent_status_changed',
      'agent_log',
      'agent_log',
      'agent_status_changed',
      'agent_status_changed',
      'agent_completed',
    ]);
    // Tras el stop, el transcript del agente gana al de arranque.
    expect(translator.getTranscriptPath('a-1')).toBe('/tmp/agent.jsonl');
  });
});
