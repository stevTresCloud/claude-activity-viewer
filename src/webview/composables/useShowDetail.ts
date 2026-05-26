/* ================================================================
 * useShowDetail.ts — Composable que centraliza el dispatch del
 * `request_show_detail` al extension host.
 *
 * Las cards (Running/Pending/Recent + Standalone) tienen el mismo
 * click handler: postear `request_show_detail` con el agentId. Sin
 * este helper, el string literal `'request_show_detail'` se repetía
 * en 5 archivos y un rename del evento tocaría todos.
 *
 * Patrón: composable thin que devuelve solo una función. Si más
 * adelante el detail panel necesita state per-card (ej. dim al
 * abrir), conviene mantener este punto de entrada y crecerlo acá.
 * ================================================================ */

import { postToExtension } from './usePostToExtension';

export function useShowDetail(): { show: (agentId: string) => void } {
  return {
    show(agentId: string) {
      postToExtension({ type: 'request_show_detail', agentId });
    },
  };
}
