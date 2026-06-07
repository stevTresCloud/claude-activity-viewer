/* ================================================================
 * format.test.ts — Tests de los formatters de display del dashboard.
 *
 * Los formatters son funciones puras sin dependencias DOM, pero el
 * archivo declara `happy-dom` para que el resolver de vitest tome
 * el mismo environment que el resto del webview (consistencia entre
 * tests del store + formatters cuando convivan en un mismo
 * `vitest run`).
 *
 * Foco de cobertura: inputs válidos representativos + edge cases
 * (NaN, Infinity, negativos, ISO inválidos, futuros). Estos son
 * los que la UI no puede provocar fácilmente pero el bridge sí
 * podría reenviar si el wire trae basura — el helper devuelve
 * fallback "—" en vez de romper la render.
 * ================================================================ */

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatCostUsd,
  formatElapsed,
  formatRelative,
  formatShortSession,
  formatTokens,
  UNKNOWN_SESSION,
} from '../format';

// =====================================================================
// === formatElapsed ===================================================
// =====================================================================

describe('formatElapsed', () => {
  it('0 ms → "0m 00s" con padding en segundos', () => {
    expect(formatElapsed(0)).toBe('0m 00s');
  });

  it('134_000 ms → "2m 14s"', () => {
    expect(formatElapsed(134_000)).toBe('2m 14s');
  });

  it('42_000 ms → "0m 42s"', () => {
    expect(formatElapsed(42_000)).toBe('0m 42s');
  });

  it('undefined → fallback "—"', () => {
    expect(formatElapsed(undefined)).toBe('—');
  });

  it('NaN → fallback "—"', () => {
    expect(formatElapsed(Number.NaN)).toBe('—');
  });

  it('negativo → fallback "—" (defensivo contra wallclock skew)', () => {
    expect(formatElapsed(-1000)).toBe('—');
  });

  it('Infinity → fallback "—"', () => {
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

// =====================================================================
// === formatRelative ==================================================
// =====================================================================

describe('formatRelative', () => {
  // Fijamos `Date.now()` cuando no se pasa nowIso explícito — el
  // test de "default Date.now()" depende del wallclock real sin esto.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T14:34:30Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const now = '2026-05-25T14:34:30Z';

  it('diff <1 minuto → segundos', () => {
    expect(formatRelative('2026-05-25T14:34:00Z', now)).toBe('30s');
  });

  it('diff <1 hora → minutos', () => {
    expect(formatRelative('2026-05-25T14:30:00Z', now)).toBe('4m');
  });

  it('diff <24h → horas', () => {
    expect(formatRelative('2026-05-25T08:30:00Z', now)).toBe('6h');
  });

  it('diff ≥24h → días', () => {
    expect(formatRelative('2026-05-22T17:00:00Z', now)).toBe('2d');
  });

  it('sin nowIso usa Date.now() (verificado con fake timer)', () => {
    expect(formatRelative('2026-05-25T14:30:00Z')).toBe('4m');
  });

  it('iso vacío/undefined → "—"', () => {
    expect(formatRelative(undefined)).toBe('—');
    expect(formatRelative('')).toBe('—');
  });

  it('iso no parseable → "—"', () => {
    expect(formatRelative('not-an-iso', now)).toBe('—');
  });

  it('nowIso no parseable → "—" (guard de Number.isFinite(now))', () => {
    // El helper también valida el segundo argumento: si el call site
    // pasa un nowIso basura, devuelve fallback en vez de devolver un
    // string sin sentido derivado de NaN-NaN.
    expect(formatRelative('2026-05-25T14:30:00Z', 'not-an-iso')).toBe('—');
  });

  it('iso futuro (past > now) → "0s" via clamp de diff a 0', () => {
    expect(formatRelative('2026-05-25T15:00:00Z', now)).toBe('0s');
  });
});

// =====================================================================
// === formatTokens ====================================================
// =====================================================================

describe('formatTokens', () => {
  it('<1000 → número raw sin sufijo', () => {
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(0)).toBe('0');
  });

  it('exactos 1000 → "1k" (entero suprime el .0)', () => {
    expect(formatTokens(1000)).toBe('1k');
  });

  it('12_000 → "12k" (entero suprime el .0)', () => {
    expect(formatTokens(12_000)).toBe('12k');
  });

  it('12_450 → "12.5k" (un decimal)', () => {
    expect(formatTokens(12_450)).toBe('12.5k');
  });

  it('22_300 → "22.3k"', () => {
    expect(formatTokens(22_300)).toBe('22.3k');
  });

  it('undefined / NaN / negativo / Infinity → "—"', () => {
    expect(formatTokens(undefined)).toBe('—');
    expect(formatTokens(Number.NaN)).toBe('—');
    expect(formatTokens(-100)).toBe('—');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

// =====================================================================
// === formatCostUsd ===================================================
// =====================================================================

describe('formatCostUsd', () => {
  it('0 → "$0.00" (caso identidad)', () => {
    expect(formatCostUsd(0)).toBe('$0.00');
  });

  it('< $0.01 usa 4 decimales (no perder precisión en agentes cortos)', () => {
    expect(formatCostUsd(0.0023)).toBe('$0.0023');
    expect(formatCostUsd(0.0001)).toBe('$0.0001');
  });

  it('$0.01 .. $1 usa 3 decimales (legible para batches chicos)', () => {
    expect(formatCostUsd(0.157)).toBe('$0.157');
    expect(formatCostUsd(0.5)).toBe('$0.500');
  });

  it('>= $1 usa 2 decimales (formato dinero estándar)', () => {
    expect(formatCostUsd(1.42)).toBe('$1.42');
    expect(formatCostUsd(12.5)).toBe('$12.50');
    expect(formatCostUsd(100)).toBe('$100.00');
  });

  it('undefined / NaN / negativo / Infinity → "—"', () => {
    expect(formatCostUsd(undefined)).toBe('—');
    expect(formatCostUsd(Number.NaN)).toBe('—');
    expect(formatCostUsd(-0.5)).toBe('—');
    expect(formatCostUsd(Number.POSITIVE_INFINITY)).toBe('—');
  });

  // === Status-aware: mid-run el SDK no expone total_cost_usd hasta el
  // `result` final. Mostrar "$0.00" engaña al user — preferimos
  // "computing…" como placeholder durante running. Subtarea G ticket #0.
  it('status=running con valor 0 o undefined → "computing…"', () => {
    expect(formatCostUsd(0, 'running')).toBe('computing…');
    expect(formatCostUsd(undefined, 'running')).toBe('computing…');
  });

  it('status=running con valor real ya llegado → format normal', () => {
    expect(formatCostUsd(0.0023, 'running')).toBe('$0.0023');
    expect(formatCostUsd(1.42, 'running')).toBe('$1.42');
  });

  it('status terminales con 0 → "$0.00" (NO "computing…")', () => {
    expect(formatCostUsd(0, 'done')).toBe('$0.00');
    expect(formatCostUsd(0, 'failed')).toBe('$0.00');
    expect(formatCostUsd(0, 'cancelled')).toBe('$0.00');
  });
});

// === formatShortSession =============================================

describe('formatShortSession', () => {
  it('UUID → primeros 8 chars', () => {
    expect(formatShortSession('aaaabbbb-1111-2222-3333-444455556666')).toBe('aaaabbbb');
  });

  it('sentinel UNKNOWN_SESSION pasa sin cortar', () => {
    expect(formatShortSession(UNKNOWN_SESSION)).toBe(UNKNOWN_SESSION);
  });

  it('string vacío cae al sentinel (no línea en blanco)', () => {
    expect(formatShortSession('')).toBe(UNKNOWN_SESSION);
  });

  it('id más corto que 8 chars se devuelve intacto', () => {
    expect(formatShortSession('abc')).toBe('abc');
  });
});
