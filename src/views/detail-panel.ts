/* ================================================================
 * detail-panel.ts — Gestiona el WebviewPanel del editor tab para
 * ver el detail de un agente.
 *
 * Diseño "1 panel live a la vez":
 *   - El usuario hace click en una card del sidebar → la card postea
 *     `request_show_detail` → este manager abre (o re-enfoca) el
 *     editor tab para ese agentId.
 *   - Si ya hay panel abierto Y matchea el mismo agentId → reveal.
 *   - Si hay panel pero distinto agentId → dispose() + create nuevo.
 *   - Si no hay panel → create.
 *
 * El bundle Vite del webview es UNO solo. Distinguimos modo
 * sidebar/detail inyectando un `<script nonce>` antes del bundle
 * que setea `window.__claudeOrchestrator = {mode: 'detail', agentId}`.
 * El App.vue lee eso via useDetailMode y renderea AgentDetailView.
 *
 * El bridge attache este webview al Set de webviews — los eventos
 * `agent_log` / `agent_log_history` viajan a todos los attached
 * (sidebar + detail). El sidebar ignora `agent_log_history`; el
 * detail lo procesa. Filtrado lado webview.
 *
 * Por qué reusar el mismo bundle vs un segundo Vite build:
 *   El segundo bundle agregaría ~40-60kb redundantes (Vue + Pinia
 *   + Tailwind cargados dos veces en RAM) y exigiría sync de
 *   esquemas. Inyección de un global es la solución clean.
 * ================================================================ */

import * as vscode from 'vscode';
import type { DashboardBridge } from '../dashboard/bridge';
import type { DashboardEventToExtension } from '../shared/dashboard-protocol';
import { buildWebviewHtml } from './webview-html';

export class DetailPanelManager implements vscode.Disposable {
  /** viewType del panel (estable, no aparece en UI). */
  public static readonly viewType = 'claudeOrchestrator.detail';

  private panel: vscode.WebviewPanel | null = null;
  private currentAgentId: string | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: DashboardBridge,
    private readonly channel: vscode.OutputChannel,
    /**
     * Callback que recibe mensajes del webview del panel detail.
     * Mismo handler que el sidebar (request_resume_session,
     * request_rescan, etc.). La extension.ts lo apunta al
     * scanner-controller. `request_hydrate_logs` se intercepta antes
     * (ver onDidReceiveMessage abajo).
     */
    private readonly onWebviewMessage?: (
      msg: DashboardEventToExtension,
    ) => void,
  ) {}

  /**
   * Abre el detail panel para un agente. Behavior:
   *   - mismo agentId que el panel actual → reveal.
   *   - distinto → dispose() + create fresh.
   *   - no hay panel → create.
   */
  showForAgent(agentId: string, agentName: string): void {
    if (!agentId) {
      this.channel.appendLine(`[detail] reject show: empty agentId`);
      return;
    }

    // Caso 1: panel existe y matchea — solo reveal.
    if (this.panel && this.currentAgentId === agentId) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    // Caso 2: panel existe pero distinto agente — destruir y recrear.
    // Más simple que "set_agent" message dinámico (cero state
    // inflight, reset limpio del LogStream).
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
      this.currentAgentId = null;
    }

    // Caso 3: crear panel fresh.
    this.createPanel(agentId, agentName);
  }

  private createPanel(agentId: string, agentName: string): void {
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, 'out', 'webview');
    const panel = vscode.window.createWebviewPanel(
      DetailPanelManager.viewType,
      `Agent: ${agentName}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [webviewRoot],
        // Mantiene el state Vue cuando el user cambia a otra tab y
        // vuelve — sino el panel rehidrata desde cero cada vez.
        retainContextWhenHidden: true,
      },
    );

    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.svg');
    // Builder compartido inyecta el script con `window.__claudeOrchestrator`
    // que el bundle Vue lee via `useDetailMode` para arrancar
    // AgentDetailView en lugar de la sidebar default.
    panel.webview.html = buildWebviewHtml({
      webview: panel.webview,
      extensionUri: this.extensionUri,
      inlineConfig: { mode: 'detail', agentId },
    });

    // El bridge incorpora el webview al broadcast set. Recibirá los
    // mismos eventos que el sidebar (agent_list inicial + agent_log
    // streaming) — el lado Vue filtra por agentId.
    const token = this.bridge.attachWebview(panel.webview);

    // Mensajes del panel hacia el extension host. Interceptamos
    // `request_hydrate_logs` para que el bridge mande la respuesta
    // SOLO a este webview — el sidebar no usa el ringbuffer
    // completo y serializarle 1000 entries era waste. El resto de
    // eventos van al callback general del scanner-controller.
    const cb = this.onWebviewMessage;
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const candidate = raw as { type?: unknown };
      if (typeof candidate.type !== 'string') return;
      const msg = raw as DashboardEventToExtension;
      if (msg.type === 'request_hydrate_logs') {
        this.bridge.hydrateLogs(msg.agentId, panel.webview);
        // Métricas del transcript (modelo/tokens/context%): lectura
        // async on-demand, fire-and-forget. Si falla degrada a no-op.
        void this.bridge.hydrateMetrics(msg.agentId, panel.webview);
        return;
      }
      if (cb) cb(msg);
    });

    // VS Code dispone el panel cuando el user cierra la tab. Nuestro
    // dispose limpia el bridge attachment y los refs internos.
    panel.onDidDispose(() => {
      this.bridge.detachWebview(token);
      // Solo limpiamos los refs si el panel disposed es el actual —
      // si showForAgent ya rotó a uno nuevo, el viejo dispose no
      // debe pisar el state nuevo.
      if (this.panel === panel) {
        this.panel = null;
        this.currentAgentId = null;
      }
    });

    this.panel = panel;
    this.currentAgentId = agentId;
    this.channel.appendLine(
      `[detail] open agent=${agentId.slice(0, 8)} name=${agentName}`,
    );
  }

  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
      this.currentAgentId = null;
    }
  }
}
