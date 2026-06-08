/* ================================================================
 * completion-notifier.ts — Toast VS Code cuando un agente termina.
 *
 * Suscrito al `bridge.onAgentCompleted`; cada vez que un agente
 * llega a estado terminal (done / failed / cancelled), muestra un
 * toast nativo con resumen + botón "Open detail". Click → abre el
 * detail panel para ese agente.
 *
 * Por qué no broadcasteamos el toast al webview en vez de usar la
 * API nativa: el sidebar puede estar cerrado / oculto; los
 * webviews no pueden mostrar notifications fuera de su iframe. El
 * `vscode.window.showInformationMessage` se renderea en la esquina
 * inferior derecha siempre, ignorando si nuestro sidebar está
 * visible — exactamente lo que el user pidió ("avisame cuando
 * termine, esté mirando el sidebar o no").
 *
 * Setting `claudeActivityViewer.notifyOnComplete` (default true)
 * permite opt-out. Útil para usuarios que lanzan muchos agentes
 * por segundo y no quieren burst de toasts.
 *
 * Severity:
 *   - done    → showInformationMessage (icono check)
 *   - failed  → showWarningMessage    (icono triángulo)
 *   - cancelled → showInformationMessage (no es error real)
 * ================================================================ */

import * as vscode from 'vscode';
import type { AgentCompletionEvent, DashboardBridge } from './bridge';
import {
  formatElapsedShort,
  formatTokens,
  truncate,
} from '../shared/format';

export interface CompletionNotifierOptions {
  bridge: DashboardBridge;
  channel: vscode.OutputChannel;
  /**
   * Handler que abre el detail panel para un agente. Se invoca
   * cuando el user clickea "Open detail" en el toast. Lo provee
   * extension.ts (delega al DetailPanelManager).
   */
  showDetail: (agentId: string, name: string) => void;
}

const OPEN_DETAIL_LABEL = 'Open detail';

export class CompletionNotifier implements vscode.Disposable {
  private readonly unsubscribe: () => void;

  constructor(private readonly options: CompletionNotifierOptions) {
    this.unsubscribe = options.bridge.onAgentCompleted((event) => {
      void this.onComplete(event);
    });
  }

  private async onComplete(event: AgentCompletionEvent): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('claudeActivityViewer');
    const enabled = cfg.get<boolean>('notifyOnComplete', true);
    if (!enabled) return;

    const message = formatMessage(event);
    this.options.channel.appendLine(
      `[notifier] toast agent=${event.agentId.slice(0, 8)} status=${event.status}`,
    );

    // Para failed usamos `showWarningMessage` para que el icono
    // del toast comunique "algo terminó mal" sin texto extra. El
    // cancelled NO es error — es acción intencional del user — así
    // que va por information.
    const showFn =
      event.status === 'failed'
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;

    const choice = await showFn(message, OPEN_DETAIL_LABEL);
    if (choice === OPEN_DETAIL_LABEL) {
      this.options.showDetail(event.agentId, event.name);
    }
  }

  dispose(): void {
    this.unsubscribe();
  }
}

/**
 * Formatea el mensaje del toast según el estado terminal. Exportable
 * para tests; las branches están en el formato del verbo + duración +
 * tokens, no en la lógica de cuándo mostrar.
 */
export function formatMessage(event: AgentCompletionEvent): string {
  const verb =
    event.status === 'done'
      ? 'finished'
      : event.status === 'failed'
        ? 'failed'
        : 'was cancelled';
  // Sin durationMs (no vimos el arranque) omitimos el "in <duración>" en
  // vez de mostrar "in 0s", que mentiría sobre lo que tardó el agente.
  const durationFragment =
    event.durationMs !== undefined ? ` in ${formatElapsedShort(event.durationMs)}` : '';
  const tokensFragment =
    event.tokensUsed > 0 ? ` · ${formatTokens(event.tokensUsed)} tokens` : '';
  const reasonFragment =
    event.status === 'failed' && event.reason
      ? ` (${truncate(event.reason, 60)})`
      : '';
  return `Agent ${event.name} ${verb}${durationFragment}${tokensFragment}${reasonFragment}`;
}
