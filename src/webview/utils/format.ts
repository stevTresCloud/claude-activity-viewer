/* ================================================================
 * format.ts — Helpers de formato para el dashboard.
 *
 * Todas las funciones devuelven strings listos para renderizar en
 * un agent card. Las medidas vienen del backend en unidades crudas
 * (ms, ISO 8601, número raw) y acá las traducimos a la grilla
 * compacta que muestra el HANDOFF (ej. "2m 14s", "12.5k", "4m ago").
 *
 * Convención: si los inputs son inválidos (undefined, NaN, ISO no
 * parseable), devolvemos un fallback corto en vez de tirar — el
 * dashboard prefiere mostrar "—" que romperse en sidebar.
 * ================================================================ */

// === Duración acumulada (elapsed de un agente running) ===

/**
 * formatElapsed — ms → "Xm Ys" con padding cero opcional.
 *
 * Ejemplos:
 *   formatElapsed(134_000) → "2m 14s"
 *   formatElapsed(42_000)  → "0m 42s"
 *   formatElapsed(0)       → "0m 00s"
 *
 * El brief (KANBAN §11.2) emite estos tiempos directos, así que el
 * format calza con la mock data 1:1. En 1.4 cuando llegue del wire,
 * el shape no cambia.
 */
export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

// === Duración cerrada (recent done/failed/cancelled) ===

/**
 * formatDuration — ms → "Xm 0Ys" (misma grilla que elapsed, con
 * padding cero a 2 dígitos en segundos).
 *
 * Visualmente equivalente a formatElapsed; los dejamos separados
 * por semántica (elapsed es "vivo", duration es "cerrado") por si
 * más adelante divergen — ej. duration podría agregar horas si
 * supera 60min (`Xh Ym`) y elapsed no.
 */
export function formatDuration(ms: number | undefined): string {
  return formatElapsed(ms);
}

// === Tiempo relativo desde un ISO (queued_since, completed_at) ===

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * formatRelative — distancia entre dos ISO timestamps, en la unidad
 * más coarse que aplique. Sin "ago" en el sufijo: el call site lo
 * agrega si lo necesita ("4m ago" en UP NEXT, "9m ago" en RECENT
 * extendido, etc.) — así el helper sirve para ambos contextos.
 *
 * Ejemplos (now = '2026-05-25T14:34:30Z'):
 *   formatRelative('2026-05-25T14:30:00Z', now) → "4m"
 *   formatRelative('2026-05-25T14:34:00Z', now) → "30s"
 *   formatRelative('2026-05-25T08:30:00Z', now) → "6h"
 *   formatRelative('2026-05-22T17:00:00Z', now) → "3d"
 *
 * `iso` o `nowIso` inválidos → "—".
 */
export function formatRelative(iso: string | undefined, nowIso: string): string {
  if (!iso) return '—';
  const past = new Date(iso).getTime();
  const now = new Date(nowIso).getTime();
  if (!Number.isFinite(past) || !Number.isFinite(now)) return '—';
  const diff = Math.max(0, now - past);

  if (diff < MS_PER_MINUTE) return `${Math.floor(diff / 1000)}s`;
  if (diff < MS_PER_HOUR) return `${Math.floor(diff / MS_PER_MINUTE)}m`;
  if (diff < MS_PER_DAY) return `${Math.floor(diff / MS_PER_HOUR)}h`;
  return `${Math.floor(diff / MS_PER_DAY)}d`;
}

// === Tokens used (formato compacto con un decimal) ===

/**
 * formatTokens — número raw → "X.Yk" o "XXk" según magnitud.
 *
 * Ejemplos:
 *   formatTokens(12_450) → "12.5k"
 *   formatTokens(22_300) → "22.3k"
 *   formatTokens(4_200)  → "4.2k"
 *   formatTokens(500)    → "500"
 *
 * El brief muestra siempre `Xk` para tokens >= 1000 con un decimal.
 * Para values menores devolvemos el número raw (no se ven en mock).
 */
export function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return n.toString();
  const k = n / 1000;
  // toFixed(1) con .0 quedaría feo ("12.0k"); preferimos el entero.
  const rounded = Math.round(k * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}k` : `${rounded.toFixed(1)}k`;
}
