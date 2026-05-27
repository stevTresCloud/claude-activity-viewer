/* ================================================================
 * format.ts — Re-export de los helpers shared.
 *
 * Los formatters viven en `src/shared/format.ts` (stack-agnostic,
 * usados también por completion-notifier y bridge del extension
 * host). Este archivo mantiene el path histórico que importan
 * cards, views y tests del webview — eliminarlo rompería ~30
 * imports.
 *
 * Si alguna vez se necesita un helper webview-only (ej. dependiente
 * de Vue refs), agregarlo acá sin re-exportar de shared.
 * ================================================================ */

export {
  formatElapsed,
  formatRelative,
  formatTokens,
  formatCostUsd,
} from '../../shared/format';
