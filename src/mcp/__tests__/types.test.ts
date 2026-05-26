/* ================================================================
 * types.test.ts — Tests del schema Zod del tool MCP `spawn_agents`.
 *
 * El MCP SDK exige el "raw shape" (objeto plano con campos a
 * schemas) — no un `z.object(...)`. Para testear envolvemos el
 * shape acá con `z.object(SPAWN_AGENTS_INPUT_SHAPE)` y ejercemos
 * `safeParse` para distinguir éxito de error sin try/catch.
 *
 * Foco:
 *   1. Inputs mínimos válidos.
 *   2. Rechazos por cwd no absoluto / vacío.
 *   3. Bounds: tasks vacío / >8 / model fuera de enum / priority
 *      fuera de enum / options.max_parallel <=0.
 *   4. Forward-compat: model/priority/max_parallel correctos pasan
 *      (el bridge los ignora hoy pero el schema los acepta).
 * ================================================================ */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SPAWN_AGENTS_INPUT_SHAPE } from '../types';

const schema = z.object(SPAWN_AGENTS_INPUT_SHAPE);

const validTask = {
  prompt: 'hola',
  cwd: '/abs/path/myproj',
};

describe('SPAWN_AGENTS_INPUT_SHAPE — inputs válidos', () => {
  it('una task mínima (prompt + cwd absoluto) pasa', () => {
    const result = schema.safeParse({ tasks: [validTask] });
    expect(result.success).toBe(true);
  });

  it('forward-compat: model/priority/max_parallel correctos pasan', () => {
    const result = schema.safeParse({
      tasks: [
        { ...validTask, model: 'opus', priority: 'high' },
      ],
      options: { project: 'override-name', max_parallel: 4 },
    });
    expect(result.success).toBe(true);
  });
});

describe('SPAWN_AGENTS_INPUT_SHAPE — inputs inválidos', () => {
  it('rechaza cwd relativo', () => {
    const result = schema.safeParse({
      tasks: [{ prompt: 'hi', cwd: './src' }],
    });
    expect(result.success).toBe(false);
  });

  it('rechaza cwd vacío', () => {
    const result = schema.safeParse({
      tasks: [{ prompt: 'hi', cwd: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('rechaza prompt vacío', () => {
    const result = schema.safeParse({
      tasks: [{ prompt: '', cwd: '/abs/path' }],
    });
    expect(result.success).toBe(false);
  });

  it('rechaza tasks vacío (min 1)', () => {
    const result = schema.safeParse({ tasks: [] });
    expect(result.success).toBe(false);
  });

  it('rechaza tasks con más de 8 entradas (max 8)', () => {
    const result = schema.safeParse({
      tasks: Array.from({ length: 9 }, () => validTask),
    });
    expect(result.success).toBe(false);
  });

  it('rechaza model fuera del enum (sonnet|opus|haiku)', () => {
    const result = schema.safeParse({
      tasks: [{ ...validTask, model: 'gpt-4' }],
    });
    expect(result.success).toBe(false);
  });

  it('rechaza priority fuera del enum (low|med|high)', () => {
    const result = schema.safeParse({
      tasks: [{ ...validTask, priority: 'urgent' }],
    });
    expect(result.success).toBe(false);
  });

  it('rechaza options.max_parallel = 0 (positive)', () => {
    const result = schema.safeParse({
      tasks: [validTask],
      options: { max_parallel: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza options.max_parallel negativo', () => {
    const result = schema.safeParse({
      tasks: [validTask],
      options: { max_parallel: -1 },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza options.project vacío (min 1)', () => {
    const result = schema.safeParse({
      tasks: [validTask],
      options: { project: '' },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza max_parallel no entero (positive int)', () => {
    const result = schema.safeParse({
      tasks: [validTask],
      options: { max_parallel: 2.5 },
    });
    expect(result.success).toBe(false);
  });

  it('rechaza name vacío (min 1) — defensa contra display name basura', () => {
    // El bridge fallback a `agent-<shortid>` si name está ausente,
    // pero si llega presente debe tener algo renderizable. Sin este
    // bound un caller podría inyectar un AgentCard ilegible en la UI.
    const result = schema.safeParse({
      tasks: [{ ...validTask, name: '' }],
    });
    expect(result.success).toBe(false);
  });
});
