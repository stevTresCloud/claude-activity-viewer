// === Tests del parser/validador de payloads de hook ===
//
// Cubrimos: cada shape válido de los 7 eventos, tolerancia a campos
// extra (forward-compat), y las 4 razones de descarte (not_object,
// no_event_name, unknown_event, schema_violation).

import { describe, expect, it } from 'vitest';
import { HOOK_EVENT_NAMES, parseHookEvent } from '../hook-events';

describe('parseHookEvent — happy path', () => {
  it('parses SubagentStart with all fields', () => {
    const result = parseHookEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'a-123',
      agent_type: 'Explore',
      session_id: 's-1',
      cwd: '/home/u/proj',
      transcript_path: '/tmp/t.jsonl',
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.event.hook_event_name === 'SubagentStart') {
      expect(result.event.agent_id).toBe('a-123');
      expect(result.event.agent_type).toBe('Explore');
    }
  });

  it('parses SubagentStart with only the required agent_id', () => {
    const result = parseHookEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'a-1',
    });
    expect(result.ok).toBe(true);
  });

  it('parses PreToolUse with agent_id (subagent)', () => {
    const result = parseHookEvent({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/x' },
      tool_use_id: 'tu-1',
      agent_id: 'a-1',
    });
    expect(result.ok).toBe(true);
  });

  it('parses PreToolUse WITHOUT agent_id (main session) as valid', () => {
    const result = parseHookEvent({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.event.hook_event_name === 'PreToolUse') {
      expect(result.event.agent_id).toBeUndefined();
    }
  });

  it('parses PostToolUse with tool_response + duration_ms', () => {
    const result = parseHookEvent({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_response: { content: 'hi' },
      duration_ms: 42,
      agent_id: 'a-1',
    });
    expect(result.ok).toBe(true);
  });

  it('parses SubagentStop with last_assistant_message = null', () => {
    const result = parseHookEvent({
      hook_event_name: 'SubagentStop',
      agent_id: 'a-1',
      last_assistant_message: null,
      agent_transcript_path: '/tmp/at.jsonl',
    });
    expect(result.ok).toBe(true);
  });

  it('parses Stop / SessionStart / SessionEnd', () => {
    expect(parseHookEvent({ hook_event_name: 'Stop' }).ok).toBe(true);
    expect(
      parseHookEvent({ hook_event_name: 'SessionStart', source: 'startup' }).ok,
    ).toBe(true);
    expect(
      parseHookEvent({ hook_event_name: 'SessionEnd', reason: 'clear' }).ok,
    ).toBe(true);
  });

  it('tolerates unknown extra fields (forward-compat via loose)', () => {
    const result = parseHookEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'a-1',
      brand_new_field: { nested: true },
    });
    expect(result.ok).toBe(true);
  });

  it('exposes the canonical event-name list', () => {
    expect(HOOK_EVENT_NAMES).toContain('SubagentStart');
    expect(HOOK_EVENT_NAMES).toContain('SubagentStop');
    expect(HOOK_EVENT_NAMES).toHaveLength(7);
  });
});

describe('parseHookEvent — rejections', () => {
  it('rejects non-objects with not_object', () => {
    for (const raw of [[], 'str', 42, null, undefined, true]) {
      const result = parseHookEvent(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('not_object');
    }
  });

  it('rejects objects without a string hook_event_name', () => {
    expect(parseHookEvent({ foo: 1 })).toMatchObject({
      ok: false,
      reason: 'no_event_name',
    });
    expect(parseHookEvent({ hook_event_name: 99 })).toMatchObject({
      ok: false,
      reason: 'no_event_name',
    });
  });

  it('rejects unknown event names with unknown_event', () => {
    expect(
      parseHookEvent({ hook_event_name: 'PreCompact' }),
    ).toMatchObject({ ok: false, reason: 'unknown_event' });
    expect(
      parseHookEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'x' }),
    ).toMatchObject({ ok: false, reason: 'unknown_event' });
  });

  it('rejects known events missing required fields with schema_violation', () => {
    // SubagentStart sin agent_id.
    expect(
      parseHookEvent({ hook_event_name: 'SubagentStart' }),
    ).toMatchObject({ ok: false, reason: 'schema_violation' });
    // PreToolUse sin tool_name.
    expect(
      parseHookEvent({ hook_event_name: 'PreToolUse', agent_id: 'a-1' }),
    ).toMatchObject({ ok: false, reason: 'schema_violation' });
    // SubagentStop sin agent_id.
    expect(
      parseHookEvent({ hook_event_name: 'SubagentStop' }),
    ).toMatchObject({ ok: false, reason: 'schema_violation' });
  });
});
