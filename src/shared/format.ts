/* ================================================================
 * format.ts — Helpers de formato compartidos entre extension host
 * (CJS) y webview (ESM). Stack-agnostic: cero deps de Vue / vscode.
 *
 * Centraliza los formatters que antes vivían en
 *   - `src/webview/utils/format.ts` (formatElapsed/Relative/Tokens)
 *   - `src/dashboard/completion-notifier.ts` (formatDurationShort/
 *     formatTokensShort/truncate locales)
 *   - `src/webview/components/detail/LogStream.vue` (truncate local)
 *   - `src/dashboard/bridge.ts` (capitalize local)
 *   - `src/commands/test-agent.ts` (capitalize local, distinta
 *     semántica que el de bridge — bug latente)
 *
 * Convención: si los inputs son inválidos (undefined, NaN), devolver
 * un fallback corto en vez de tirar. La UI prefiere mostrar "—" que
 * romperse.
 * ================================================================ */

// === Duración (elapsed/duration en ms) ===

/**
 * formatElapsed — ms → "Xm 0Ys" con padding cero en segundos.
 * Pensado para cards del dashboard (HANDOFF §11.2). El padding
 * evita que la columna baile cuando los segundos cambian de 9 a 10.
 *
 * Ejemplos:
 *   formatElapsed(134_000) → "2m 14s"
 *   formatElapsed(42_000)  → "0m 42s"
 *   formatElapsed(0)       → "0m 00s"
 */
export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

/**
 * formatElapsedShort — ms → "Xs" para <60s, "Xm Ys" en adelante.
 * Sin "0m" prefix ni padding. Pensado para toasts y mensajes en
 * prosa donde "0m 04s" se ve ruidoso.
 *
 * Ejemplos:
 *   formatElapsedShort(4_321)   → "4s"
 *   formatElapsedShort(134_000) → "2m 14s"
 *   formatElapsedShort(0)       → "0s"
 */
export function formatElapsedShort(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

// === Tiempo relativo entre dos ISO ===

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * formatRelative — distancia entre dos ISO timestamps en la unidad
 * más coarse que aplique. Sin "ago" en el sufijo (lo agrega el call
 * site). Default `nowIso = Date.now()`.
 *
 * Ejemplos (now = '2026-05-25T14:34:30Z'):
 *   formatRelative('2026-05-25T14:30:00Z', now) → "4m"
 *   formatRelative('2026-05-25T14:34:00Z', now) → "30s"
 *   formatRelative('2026-05-25T08:30:00Z', now) → "6h"
 *   formatRelative('2026-05-22T17:00:00Z', now) → "3d"
 */
export function formatRelative(
  iso: string | undefined,
  nowIso?: string,
): string {
  if (!iso) return '—';
  const past = new Date(iso).getTime();
  const now = nowIso ? new Date(nowIso).getTime() : Date.now();
  if (!Number.isFinite(past) || !Number.isFinite(now)) return '—';
  const diff = Math.max(0, now - past);
  if (diff < MS_PER_MINUTE) return `${Math.floor(diff / 1000)}s`;
  if (diff < MS_PER_HOUR) return `${Math.floor(diff / MS_PER_MINUTE)}m`;
  if (diff < MS_PER_DAY) return `${Math.floor(diff / MS_PER_HOUR)}h`;
  return `${Math.floor(diff / MS_PER_DAY)}d`;
}

// === Tokens ===

/**
 * formatTokens — número raw → "Xk" o "X.Yk" para >= 1000, raw para
 * menos. Sin sufijo "tokens" (lo agrega el call site).
 *
 * Ejemplos:
 *   formatTokens(12_450) → "12.5k"
 *   formatTokens(22_300) → "22.3k"
 *   formatTokens(4_200)  → "4.2k"
 *   formatTokens(500)    → "500"
 */
export function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return n.toString();
  const k = n / 1000;
  const rounded = Math.round(k * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}k` : `${rounded.toFixed(1)}k`;
}

// === Cost USD ===

/**
 * formatCostUsd — número en USD (puede ser fraccional pequeño) → string
 * con prefijo `$` y precisión adaptativa según magnitud. Pensado para
 * cards del dashboard y consolidados del chat.
 *
 * Adaptación de precisión:
 *   - < $0.01 → 4 decimales para no perder "$0.0023" como "$0.00".
 *   - < $1    → 3 decimales (legible para batches chicos).
 *   - >= $1   → 2 decimales (formato dinero estándar).
 *
 * Ejemplos:
 *   formatCostUsd(0)         → "$0.00"
 *   formatCostUsd(0.0023)    → "$0.0023"
 *   formatCostUsd(0.157)     → "$0.157"
 *   formatCostUsd(1.42)      → "$1.42"
 *   formatCostUsd(12.5)      → "$12.50"
 *   formatCostUsd(undefined) → "—"
 */
export function formatCostUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

// === Strings ===

/**
 * capitalize — primera letra mayúscula, resto en minúscula.
 * Normaliza a Title-Case desde aliases que pueden venir en cualquier
 * caso (`sonnet`, `Sonnet`, `SONNET` → todos a `Sonnet`). Usado por
 * `prettyModel` para formatear el id del SDK y por la UI del palette
 * para mostrar el alias seleccionado.
 *
 * Si el caller necesita preservar el caso del tail (ej. nombres
 * propios "McDonald"), usar manipulación directa — no este helper.
 */
export function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * truncate — corta el string a `max` chars y agrega "…" al final si
 * fue cortado. NO truncamiddle (esa variante vive aparte en
 * `bridge.subtitleFromToolInput` porque el tool name necesita
 * conservar ambos extremos).
 *
 * Ejemplos:
 *   truncate("hola mundo", 5) → "hola…"
 *   truncate("hola", 10)      → "hola"
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Convierte segundos a milisegundos. Centraliza el cast en un solo
 * lugar: los settings del plugin (`maxAgentRuntimeSec`,
 * `stuckDetectionSec`) y el shape MCP (`timeout_sec`) viven en
 * segundos por DX, pero el código operativo (setTimeout, comparación
 * con Date.now()) usa ms.
 */
export function secondsToMs(s: number): number {
  return s * 1000;
}
