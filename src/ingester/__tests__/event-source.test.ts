// === Tests del event-source (tail NDJSON) ===
//
// Contra un archivo temporal real: ejercemos el offset tracking
// (append incremental), líneas parciales, skip de líneas corruptas y
// reset en truncado/rotación. Llamamos drain() a mano para no depender
// de timers ni del scheduler del SO.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlEventSource } from '../event-source';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ingester-source-'));
  filePath = join(dir, 'events.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function collect(source: JsonlEventSource): unknown[] {
  const seen: unknown[] = [];
  source.onEvent((raw) => seen.push(raw));
  return seen;
}

describe('JsonlEventSource', () => {
  it('starts from EOF: pre-existing lines are not replayed', () => {
    fs.writeFileSync(filePath, JSON.stringify({ old: 1 }) + '\n');
    const source = new JsonlEventSource({ filePath, pollMs: 0 });
    const seen = collect(source);
    source.start(); // offset = current size

    fs.appendFileSync(filePath, JSON.stringify({ fresh: 2 }) + '\n');
    source.drain();

    expect(seen).toEqual([{ fresh: 2 }]);
    source.dispose();
  });

  it('reads multiple appended lines in order', () => {
    const source = new JsonlEventSource({ filePath, pollMs: 0 });
    const seen = collect(source);
    source.start();

    fs.appendFileSync(
      filePath,
      JSON.stringify({ n: 1 }) + '\n' + JSON.stringify({ n: 2 }) + '\n',
    );
    source.drain();

    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    source.dispose();
  });

  it('retains a partial line until its newline arrives', () => {
    const source = new JsonlEventSource({ filePath, pollMs: 0 });
    const seen = collect(source);
    source.start();

    // Append sin '\n' final → línea incompleta, no se emite todavía.
    fs.appendFileSync(filePath, '{"half":');
    source.drain();
    expect(seen).toEqual([]);

    // Completa la línea.
    fs.appendFileSync(filePath, ' true}\n');
    source.drain();
    expect(seen).toEqual([{ half: true }]);
    source.dispose();
  });

  it('skips corrupt lines but keeps processing valid ones', () => {
    const source = new JsonlEventSource({ filePath, pollMs: 0 });
    const seen = collect(source);
    source.start();

    fs.appendFileSync(
      filePath,
      'not json\n' + JSON.stringify({ ok: true }) + '\n',
    );
    source.drain();

    expect(seen).toEqual([{ ok: true }]);
    expect(source.skippedCount).toBe(1);
    source.dispose();
  });

  it('resets to 0 when the file shrinks (truncation / rotation)', () => {
    const source = new JsonlEventSource({ filePath, pollMs: 0 });
    const seen = collect(source);
    source.start();

    // Primer contenido deliberadamente largo para que la rotación
    // encoja el archivo (size < offset = la señal de truncado).
    fs.appendFileSync(filePath, JSON.stringify({ a: 1, pad: 'xxxxxxxxxx' }) + '\n');
    source.drain();

    // Rotación: el archivo se reescribe desde cero, más corto.
    fs.writeFileSync(filePath, JSON.stringify({ b: 2 }) + '\n');
    source.drain();

    expect(seen).toEqual([{ a: 1, pad: 'xxxxxxxxxx' }, { b: 2 }]);
    source.dispose();
  });

  it('reassembles a multibyte UTF-8 char split across two reads', () => {
    const source = new JsonlEventSource({ filePath, pollMs: 0 });
    const seen = collect(source);
    source.start();

    // '…' = 3 bytes UTF-8 (E2 80 A6). Cortamos el append en medio de esa
    // secuencia: el primer drain no debe emitir ni corromper.
    const full = Buffer.from(JSON.stringify({ x: 'a…b' }) + '\n', 'utf8');
    const cut = full.indexOf(0xe2) + 1; // dentro del char multibyte
    fs.appendFileSync(filePath, full.subarray(0, cut));
    source.drain();
    expect(seen).toEqual([]);
    expect(source.skippedCount).toBe(0);

    fs.appendFileSync(filePath, full.subarray(cut));
    source.drain();
    expect(seen).toEqual([{ x: 'a…b' }]);
    source.dispose();
  });

  it('creates the spool file on start if missing', () => {
    expect(fs.existsSync(filePath)).toBe(false);
    const source = new JsonlEventSource({ filePath, pollMs: 0 });
    source.start();
    expect(fs.existsSync(filePath)).toBe(true);
    source.dispose();
  });
});
