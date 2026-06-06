/* ================================================================
 * transcript-reader.test.ts — Tests del parser de métricas del `.jsonl`.
 *
 * Estrategia:
 *   - `extractMetrics` es puro (recibe líneas): la mayoría de los
 *     casos se ejercitan pasándole arrays de strings, sin tocar disco.
 *   - `readTranscriptMetrics` se cubre con un fixture real en tmp +
 *     los caminos de degradación (path undefined / inexistente → {}).
 *   - `prettifyModel` y `contextWindowFor` (helpers puros) tienen sus
 *     propios casos.
 *
 * Casos cubiertos:
 *   - happy: último assistant con model + usage → métricas completas.
 *   - último assistant gana sobre los previos.
 *   - truncado: última línea parcial se saltea, gana el assistant previo.
 *   - sin assistant → {}.
 *   - usage ausente → solo { model }.
 *   - JSON malformado (todo basura) → {}.
 *   - cálculo de % (suma de los 3 token fields + redondeo).
 *   - variante [1m] → ventana 1M.
 *   - readTranscriptMetrics: path undefined / inexistente → {}; fixture OK.
 * ================================================================ */

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  contextWindowFor,
  extractMetrics,
  prettifyModel,
  readTranscriptMetrics,
} from '../transcript-reader';

// === Helpers ===

/** Serializa un objeto como una línea JSONL. */
function line(obj: unknown): string {
  return JSON.stringify(obj);
}

/** Construye un evento assistant con model + (opcional) usage. */
function assistant(
  model: string,
  usage?: Record<string, number>,
): string {
  return line({ type: 'assistant', message: { model, ...(usage ? { usage } : {}) } });
}

const tmpFiles: string[] = [];
afterAll(() => {
  for (const f of tmpFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ya borrado */
    }
  }
});

function writeTmp(content: string): string {
  const file = path.join(
    os.tmpdir(),
    `co-transcript-test-${process.pid}-${tmpFiles.length}.jsonl`,
  );
  fs.writeFileSync(file, content, 'utf-8');
  tmpFiles.push(file);
  return file;
}

// === extractMetrics ===

describe('extractMetrics', () => {
  it('deriva model + contextTokens + pct + tokensUsed del último assistant', async () => {
    const lines = [
      line({ type: 'user', message: { content: 'hola' } }),
      assistant('claude-opus-4-8', {
        input_tokens: 100,
        cache_read_input_tokens: 99_900,
        cache_creation_input_tokens: 0,
        output_tokens: 500,
      }),
    ];
    const m = await extractMetrics(lines);
    expect(m).toEqual({
      model: 'Opus 4.8',
      contextTokens: 100_000,
      contextUsedPct: 50, // 100000 / 200000 = 50%
      tokensUsed: 500,
    });
  });

  it('el último assistant gana sobre los previos', async () => {
    const lines = [
      assistant('claude-sonnet-4-6', { input_tokens: 10, output_tokens: 1 }),
      assistant('claude-opus-4-8', { input_tokens: 20, output_tokens: 2 }),
    ];
    const m = await extractMetrics(lines);
    expect(m.model).toBe('Opus 4.8');
    expect(m.tokensUsed).toBe(2);
  });

  it('tolera una última línea truncada y usa el assistant previo', async () => {
    const lines = [
      assistant('claude-opus-4-8', { input_tokens: 50, output_tokens: 5 }),
      '{"type":"assistant","message":{"model":"claude-sonnet', // truncado
    ];
    const m = await extractMetrics(lines);
    expect(m.model).toBe('Opus 4.8');
  });

  it('sin eventos assistant devuelve {}', async () => {
    const lines = [
      line({ type: 'user', message: { content: 'hola' } }),
      line({ type: 'result', subtype: 'success' }),
    ];
    expect(await extractMetrics(lines)).toEqual({});
  });

  it('assistant sin usage devuelve solo { model }', async () => {
    const m = await extractMetrics([assistant('claude-sonnet-4-6')]);
    expect(m).toEqual({ model: 'Sonnet 4.6' });
    expect(m.contextTokens).toBeUndefined();
    expect(m.contextUsedPct).toBeUndefined();
    expect(m.tokensUsed).toBeUndefined();
  });

  it('líneas no-JSON se saltean; todo basura devuelve {}', async () => {
    const lines = ['not json at all', '{ broken', '====='];
    expect(await extractMetrics(lines)).toEqual({});
  });

  it('suma los 3 token fields de context y redondea el %', async () => {
    const m = await extractMetrics([
      assistant('claude-opus-4-8', {
        input_tokens: 1_000,
        cache_read_input_tokens: 50_000,
        cache_creation_input_tokens: 2_000,
        output_tokens: 42,
      }),
    ]);
    expect(m.contextTokens).toBe(53_000);
    // 53000 / 200000 = 26.5 → round = 27
    expect(m.contextUsedPct).toBe(27);
    expect(m.tokensUsed).toBe(42);
  });

  it('variante [1m] usa ventana de 1M para el %', async () => {
    const m = await extractMetrics([
      assistant('claude-opus-4-8[1m]', {
        input_tokens: 100_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 10,
      }),
    ]);
    expect(m.model).toBe('Opus 4.8 (1M)');
    expect(m.contextTokens).toBe(100_000);
    // 100000 / 1_000_000 = 10%
    expect(m.contextUsedPct).toBe(10);
  });
});

// === Helpers de modelo ===

describe('prettifyModel', () => {
  it('mapea ids conocidos a display strings', () => {
    expect(prettifyModel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(prettifyModel('claude-opus-4-8[1m]')).toBe('Opus 4.8 (1M)');
    expect(prettifyModel('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(prettifyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(prettifyModel('claude-3-5-haiku-20241022')).toBe('Haiku 3.5');
  });

  it('devuelve el id crudo cuando no reconoce la familia', () => {
    expect(prettifyModel('gpt-4o')).toBe('gpt-4o');
  });
});

describe('contextWindowFor', () => {
  it('200k por defecto, 1M con sufijo [1m] (case-insensitive)', () => {
    expect(contextWindowFor('claude-opus-4-8')).toBe(200_000);
    expect(contextWindowFor('claude-opus-4-8[1m]')).toBe(1_000_000);
    expect(contextWindowFor('claude-opus-4-8[1M]')).toBe(1_000_000);
  });
});

// === readTranscriptMetrics (I/O) ===

describe('readTranscriptMetrics', () => {
  it('path undefined → {}', async () => {
    expect(await readTranscriptMetrics(undefined)).toEqual({});
  });

  it('path inexistente → {} (error de I/O confinado)', async () => {
    const m = await readTranscriptMetrics('/no/such/transcript.jsonl');
    expect(m).toEqual({});
  });

  it('lee un transcript real desde disco', async () => {
    const file = writeTmp(
      [
        line({ type: 'user', message: { content: 'go' } }),
        assistant('claude-sonnet-4-6', {
          input_tokens: 1_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 7,
        }),
      ].join('\n') + '\n',
    );
    const m = await readTranscriptMetrics(file);
    expect(m.model).toBe('Sonnet 4.6');
    expect(m.contextTokens).toBe(1_000);
    expect(m.tokensUsed).toBe(7);
  });
});
