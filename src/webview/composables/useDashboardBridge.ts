/* ================================================================
 * useDashboardBridge.ts — Adapter postMessage → Pinia store.
 *
 * Escucha `window.message` (los eventos que postea el bridge del
 * extension host vía `webview.postMessage(...)`) y los traduce a
 * actions de mutación del store de agentes.
 *
 * Pensado como singleton de aplicación: se invoca UNA vez desde
 * App.vue al mount. NO usar desde componentes hijos — el listener
 * es global a la ventana del webview y duplicarlo cablearía cada
 * action múltiples veces por evento.
 *
 * Por qué composable y no plugin de Pinia:
 *   - El listener es DOM-bound (window.addEventListener). Vive
 *     más cómodamente al lado del lifecycle de un componente
 *     (App) que en un plugin que arranca antes del mount.
 *   - El cleanup en onUnmounted es trivial — el patrón composable
 *     ya lo cubre.
 *
 * Eventos manejados: los 5 del contrato (agent_list,
 * agent_created, agent_status_changed, agent_log,
 * agent_completed). Cualquier otro tipo cae al default y se
 * ignora silenciosamente (forward-compat con eventos nuevos que
 * el bridge agregue en fases futuras).
 *
 * Referencia: src/shared/dashboard-protocol.ts.
 * ================================================================ */

import { onMounted, onUnmounted } from 'vue';
import { useAgentsStore } from '../stores/useAgentsStore';
import { useScannerStore } from '../stores/useScannerStore';
import type { DashboardEventToWebview } from '../../shared/dashboard-protocol';

export function useDashboardBridge(): void {
  const agents = useAgentsStore();
  const scanner = useScannerStore();

  // Tipamos el message handler con DashboardEventToWebview para
  // que el switch narrow-e cada case sin casts.
  function onMessage(ev: MessageEvent<DashboardEventToWebview>): void {
    // Defensa básica: VS Code postea otros mensajes al webview en
    // algunos casos (ej. window.vscode.setState). Filtramos por
    // shape: nuestros eventos siempre traen `type` string conocido.
    const data = ev.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
      return;
    }

    switch (data.type) {
      case 'agent_list':
        agents.applyAgentList(data.agents);
        break;
      case 'agent_created':
        agents.addAgent(data.agent);
        break;
      case 'agent_status_changed':
        agents.updateAgentStatus(data.agentId, data.status, data.metadata);
        break;
      case 'agent_log':
        agents.appendLog(data.agentId, data.entry);
        break;
      case 'agent_log_history':
        // Llega cuando el detail panel pidió `request_hydrate_logs`
        // al montarse. Reemplaza el ringbuffer per-agent en el
        // store (los entries vienen ordenados y bounded del bridge).
        agents.replaceLogsForAgent(data.agentId, data.entries);
        break;
      case 'agent_completed':
        agents.markAgentCompleted(data.agentId, data.result);
        break;
      case 'agent_metrics':
        // Llega cuando el detail panel pidió `request_hydrate_logs`: el
        // bridge leyó el transcript y derivó modelo/tokens/context%.
        // Se mergean al snapshot; ModelBadge/ContextBar se encienden.
        agents.applyMetrics(data.agentId, data.metrics);
        break;
      case 'projects_from_disk':
        scanner.applyProjectsFromDisk(data.projects, data.scannedAtIso);
        break;
      case 'sessions_from_disk':
        scanner.applySessionsFromDisk(data.sessions, data.scannedAtIso);
        break;
      case 'transport_state_changed':
        agents.setTransportState(data.state);
        break;
      default: {
        // Forward-compat: si el bridge agrega un evento nuevo no
        // declarado en el contrato compartido, lo ignoramos en
        // vez de tirar — así un downgrade del webview no rompe
        // el render.
        const _exhaustive: never = data;
        void _exhaustive;
        break;
      }
    }
  }

  onMounted(() => {
    window.addEventListener('message', onMessage);
  });

  onUnmounted(() => {
    window.removeEventListener('message', onMessage);
  });
}
