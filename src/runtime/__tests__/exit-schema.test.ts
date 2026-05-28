/* ================================================================
 * exit-schema.test.ts — Cobertura de parseExitSchema +
 * parseCriticOutput + buildCriticPrompt + buildExitSchemaInstruction.
 *
 * Helpers puros sin VS Code deps; los tests no levantan ni mocks de
 * extension host ni nada del SDK.
 * ================================================================ */

import { describe, expect, test } from 'vitest';
import {
  CRITIC_DIFF_MAX_BYTES,
  CRITIC_TOOL_ALLOWLIST,
  buildCriticPrompt,
  buildExitSchemaInstruction,
  parseCriticOutput,
  parseExitSchema,
} from '../exit-schema';

// === parseExitSchema ===

describe('parseExitSchema', () => {
  test('happy path: valid fenced ```json extracts and validates', () => {
    const text = [
      'Cambié el archivo a.py y corrí ast.parse.',
      '',
      '```json',
      '{',
      '  "status": "ok",',
      '  "files_changed": ["a.py"],',
      '  "evidence_run": ["ast.parse OK on a.py"],',
      '  "decisions_made_without_consultation": [],',
      '  "uncertainties": []',
      '}',
      '```',
    ].join('\n');

    const r = parseExitSchema(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.status).toBe('ok');
      expect(r.parsed.files_changed).toEqual(['a.py']);
      expect(r.parsed.evidence_run).toEqual(['ast.parse OK on a.py']);
    }
  });

  test('null/empty input returns no_input', () => {
    expect(parseExitSchema(null)).toEqual({ ok: false, reason: 'no_input' });
    expect(parseExitSchema('')).toEqual({ ok: false, reason: 'no_input' });
    expect(parseExitSchema(undefined)).toEqual({ ok: false, reason: 'no_input' });
  });

  test('text without any JSON block returns no_json_block', () => {
    const r = parseExitSchema('Solo prosa sin JSON ni código.');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_json_block');
  });

  test('malformed JSON inside fence returns invalid_json with raw', () => {
    const text = '```json\n{ status: "ok", missing quotes }\n```';
    const r = parseExitSchema(text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('invalid_json');
      expect(r.raw).toContain('status');
    }
  });

  test('valid JSON but missing required status returns schema_violation', () => {
    const text = '```json\n{"files_changed": []}\n```';
    const r = parseExitSchema(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('schema_violation');
  });

  test('extra fields are tolerated (passthrough)', () => {
    const text = [
      '```json',
      '{',
      '  "status": "ok",',
      '  "notes": "agente quiso decir algo extra",',
      '  "next_steps": ["x"],',
      '  "decisions_made_without_consultation": [],',
      '  "uncertainties": []',
      '}',
      '```',
    ].join('\n');
    const r = parseExitSchema(text);
    expect(r.ok).toBe(true);
  });

  test('omitted array fields default to []', () => {
    const text = '```json\n{"status": "ok"}\n```';
    const r = parseExitSchema(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.files_changed).toEqual([]);
      expect(r.parsed.evidence_run).toEqual([]);
      expect(r.parsed.decisions_made_without_consultation).toEqual([]);
      expect(r.parsed.uncertainties).toEqual([]);
    }
  });

  test('picks the LAST fenced json block when multiple are present', () => {
    const text = [
      'Ejemplo intermedio:',
      '```json',
      '{ "status": "failed", "uncertainties": ["esto no va"] }',
      '```',
      '',
      'Reporte final:',
      '```json',
      '{ "status": "needs_review", "decisions_made_without_consultation": ["flipped X"] }',
      '```',
    ].join('\n');
    const r = parseExitSchema(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.status).toBe('needs_review');
      expect(r.parsed.decisions_made_without_consultation).toEqual(['flipped X']);
    }
  });

  test('plain fenced ``` block (no language tag) with JSON inside is accepted', () => {
    const text = '```\n{ "status": "ok", "uncertainties": ["x"] }\n```';
    const r = parseExitSchema(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.status).toBe('ok');
      expect(r.parsed.uncertainties).toEqual(['x']);
    }
  });

  test('bare JSON object at end (no fences) is detected as last-resort', () => {
    const text =
      'Hice el cambio y corrí tests.\n\n{ "status": "ok", "files_changed": ["b.py"] }';
    const r = parseExitSchema(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed.files_changed).toEqual(['b.py']);
  });

  test('huge input (>2MB) is truncated from the start to preserve trailing JSON', () => {
    const filler = 'x'.repeat(3 * 1024 * 1024);
    const text = `${filler}\n\`\`\`json\n{"status":"ok"}\n\`\`\``;
    const r = parseExitSchema(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed.status).toBe('ok');
  });

  test('decisions_made_without_consultation typed as non-array returns schema_violation', () => {
    const text = '```json\n{"status":"ok","decisions_made_without_consultation":"not an array"}\n```';
    const r = parseExitSchema(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('schema_violation');
  });
});

// === parseCriticOutput ===

describe('parseCriticOutput', () => {
  test('happy path: valid critic output extracts flags + summary', () => {
    const text = [
      'Revisé el diff y encontré 1 flag.',
      '',
      '```json',
      '{',
      '  "flags": [',
      '    { "file": "a.py", "line": 42, "severity": "high", "summary": "assertion flipped" }',
      '  ],',
      '  "summary": "1 high-severity finding"',
      '}',
      '```',
    ].join('\n');
    const r = parseCriticOutput(text);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].severity).toBe('high');
    expect(r.flags[0].file).toBe('a.py');
    expect(r.summary).toBe('1 high-severity finding');
  });

  test('empty flags array is valid (no concerns case)', () => {
    const r = parseCriticOutput('```json\n{"flags":[],"summary":"no concerns"}\n```');
    expect(r.flags).toEqual([]);
    expect(r.summary).toBe('no concerns');
  });

  test('null/empty text returns critic_no_output low-severity flag', () => {
    const r = parseCriticOutput(null);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].severity).toBe('low');
    expect(r.summary).toBe('critic_no_output');
  });

  test('text without JSON returns critic_no_json_block low-severity flag', () => {
    const r = parseCriticOutput('Solo prosa, sin reporte.');
    expect(r.flags[0].severity).toBe('low');
    expect(r.summary).toBe('critic_no_json_block');
  });

  test('malformed JSON returns critic_invalid_json low-severity flag', () => {
    const r = parseCriticOutput('```json\n{ flags: not valid }\n```');
    expect(r.flags[0].severity).toBe('low');
    expect(r.summary).toBe('critic_invalid_json');
  });

  test('schema violation returns critic_schema_violation low-severity flag', () => {
    const r = parseCriticOutput(
      '```json\n{"flags":[{"severity":"weird","summary":"x"}]}\n```',
    );
    expect(r.flags[0].severity).toBe('low');
    expect(r.summary).toBe('critic_schema_violation');
  });
});

// === buildCriticPrompt ===

describe('buildCriticPrompt', () => {
  test('includes agent name, subtitle, exit report and diff', () => {
    const prompt = buildCriticPrompt({
      agentName: 'agent-X',
      agentSubtitle: 'edit a.py',
      exitReport: {
        status: 'ok',
        files_changed: ['a.py'],
        evidence_run: [],
        decisions_made_without_consultation: [],
        uncertainties: [],
      },
      diff: '--- a/a.py\n+++ b/a.py',
      diffTruncated: false,
    });
    expect(prompt).toContain('agent-X');
    expect(prompt).toContain('edit a.py');
    expect(prompt).toContain('--- a/a.py');
    expect(prompt).toContain('"files_changed"');
    expect(prompt).not.toContain('diff truncated at');
  });

  test('marks truncated diff with suffix when diffTruncated=true', () => {
    const prompt = buildCriticPrompt({
      agentName: 'agent-Y',
      diff: 'huge diff',
      diffTruncated: true,
    });
    expect(prompt).toContain(`--- diff truncated at ${CRITIC_DIFF_MAX_BYTES} bytes ---`);
  });

  test('handles missing exit report (parser failed) gracefully', () => {
    const prompt = buildCriticPrompt({
      agentName: 'agent-Z',
      diff: 'some diff',
      diffTruncated: false,
    });
    expect(prompt).toContain('did not produce a parseable exit report');
  });

  test('enforces no-write constraint in the prompt', () => {
    const prompt = buildCriticPrompt({
      agentName: 'a',
      diff: 'd',
      diffTruncated: false,
    });
    expect(prompt).toContain('MUST NOT use Write, Edit');
    expect(prompt).toContain('FLAG concerns');
  });

  test('includes "What NOT to flag" calibration block to curb over-eager findings', () => {
    // Calibración del prompt (post-smoke): el critic Haiku flaggeaba
    // tareas triviales (helper sin integrar, empty evidence_run en
    // cambios aditivos). El bloque NOT-to-flag le da reglas explícitas
    // de cuándo callarse — sin esto el badge pierde credibilidad.
    const prompt = buildCriticPrompt({
      agentName: 'a',
      diff: 'd',
      diffTruncated: false,
    });
    expect(prompt).toContain('What NOT to flag');
    expect(prompt).toContain('helper function, constant, or import');
    expect(prompt).toContain('Empty `evidence_run` for purely additive changes');
    expect(prompt).toContain('Speculative future risks');
    expect(prompt).toContain('When in doubt, prefer NO flag');
  });
});

// === buildExitSchemaInstruction ===

describe('buildExitSchemaInstruction', () => {
  test('returns the exit instruction block with the 4 mandatory rules', () => {
    const instruction = buildExitSchemaInstruction();
    expect(instruction).toContain('Exit report (mandatory)');
    expect(instruction).toContain('decisions_made_without_consultation');
    expect(instruction).toContain('uncertainties');
    // Las 4 reglas numeradas.
    expect(instruction).toMatch(/1\. \*\*If you made/);
    expect(instruction).toMatch(/2\. \*\*If you copied/);
    expect(instruction).toMatch(/3\. A `"status": "ok"`/);
    expect(instruction).toMatch(/4\. This JSON block must be/);
  });
});

// === Tool allowlist constants ===

describe('CRITIC_TOOL_ALLOWLIST', () => {
  test('Read and Bash are present; Write and Edit are NOT', () => {
    expect(CRITIC_TOOL_ALLOWLIST).toContain('Read');
    expect(CRITIC_TOOL_ALLOWLIST).toContain('Bash');
    expect(CRITIC_TOOL_ALLOWLIST).not.toContain('Write');
    expect(CRITIC_TOOL_ALLOWLIST).not.toContain('Edit');
    expect(CRITIC_TOOL_ALLOWLIST).not.toContain('NotebookEdit');
  });
});
