import * as path from 'node:path';
import * as vscode from 'vscode';
import { DashboardViewProvider } from './views/dashboard';
import { DetailPanelManager } from './views/detail-panel';
import { DashboardBridge } from './dashboard/bridge';
import { ScannerController } from './dashboard/scanner-controller';
import { FOCUS_DASHBOARD_COMMAND, StatusBarManager } from './dashboard/status-bar';
import { CompletionNotifier } from './dashboard/completion-notifier';
import { deriveProjectContext, expandUserHome } from './dashboard/project-context';
import {
  createFileIngester,
  defaultHookPaths,
  installHook,
  uninstallHook,
} from './ingester';
import type {
  DashboardEventToExtension,
  DashboardEventToWebview,
} from './shared/dashboard-protocol';

/**
 * Punto de entrada de la extensión Claude Activity Viewer.
 *
 * `activate` se dispara con el `activationEvent` `onStartupFinished`.
 * El viewer es read-only: NO lanza ni coordina agentes. Escucha la
 * actividad de los agentes de Claude Code vía hooks globales (el
 * ingester) y la refleja en el kanban. Registra los comandos, crea el
 * OutputChannel compartido, instancia el bridge (store del observador),
 * cablea el ingester al bridge y arranca los scanners de sesiones.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // OutputChannel compartido para todo el extension host. Vive en
  // context.subscriptions para que VS Code lo libere al desactivar.
  const channel = vscode.window.createOutputChannel('Claude Orchestrator');
  context.subscriptions.push(channel);

  // Comando smoke histórico: confirma que el extension host nos puede
  // disparar comandos.
  const helloCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.hello',
    () => {
      vscode.window.showInformationMessage('Claude Activity Viewer activo.');
    },
  );
  context.subscriptions.push(helloCmd);

  // === Bridge: store del observador ===
  // Registry de agentes + broadcast a los webviews + persistencia.
  // Su fuente de datos es el ingester (vía bridge.ingest).
  const bridge = new DashboardBridge({ context, channel });
  await bridge.hydrate();

  context.subscriptions.push({
    dispose: () => {
      bridge.dispose().catch((err) => {
        channel.appendLine(
          `[bridge] !!! dispose error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
  });

  // === Scanner controller ===
  // Orquesta los scanners de proyectos + sesiones históricas, su
  // auto-refresh y el handler de Resume. Arranca post-hydrate.
  const scanner = new ScannerController({ context, channel, bridge });
  scanner.start();
  context.subscriptions.push({ dispose: () => scanner.stop() });

  // Comando palette: re-scan manual.
  const rescanCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.rescan',
    () => {
      void scanner.rescan('manual');
    },
  );
  context.subscriptions.push(rescanCmd);

  // === Status bar item con conteo de agentes running ===
  const statusBar = new StatusBarManager(bridge);
  context.subscriptions.push(statusBar);

  const focusDashboardCmd = vscode.commands.registerCommand(
    FOCUS_DASHBOARD_COMMAND,
    () => {
      // El viewContainer id del package.json es `claudeOrchestrator`.
      // VS Code expone `workbench.view.extension.<id>` para enfocarlo.
      void vscode.commands.executeCommand(
        'workbench.view.extension.claudeOrchestrator',
      );
    },
  );
  context.subscriptions.push(focusDashboardCmd);

  // === Detail panel (editor tab) ===
  // Abre on-demand cuando el user clickea el body de una card del
  // sidebar (event `request_show_detail`). Single-instance.
  const detailPanel = new DetailPanelManager(
    context.extensionUri,
    bridge,
    channel,
    (msg) => scanner.handleMessage(msg),
  );
  context.subscriptions.push(detailPanel);

  // === Completion notifier ===
  // Toast VS Code "Agent X finished" cuando un agente termina.
  const completionNotifier = new CompletionNotifier({
    bridge,
    channel,
    showDetail: (agentId, name) => detailPanel.showForAgent(agentId, name),
  });
  context.subscriptions.push(completionNotifier);

  // === Handler webview→ext del `request_show_detail` ===
  // Lo separamos del scanner-controller porque el manager del detail
  // panel vive en views/. Wireamos un proxy que intercepta el
  // show_detail y delega el resto al scanner.
  const handleWebviewMessage = (msg: DashboardEventToExtension): void => {
    if (msg.type === 'request_show_detail') {
      const name = bridge.getAgentName(msg.agentId) ?? msg.agentId.slice(0, 8);
      detailPanel.showForAgent(msg.agentId, name);
      return;
    }
    scanner.handleMessage(msg);
  };

  // === Dashboard webview (sidebar) ===
  const dashboardProvider = new DashboardViewProvider(
    context.extensionUri,
    bridge,
    handleWebviewMessage,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DashboardViewProvider.viewType,
      dashboardProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ====================================================================
  // === Activity viewer ingester =======================================
  // ====================================================================
  // Motor del viewer: escucha la actividad de los agentes de Claude Code
  // vía hooks globales (NDJSON spool + tail) y la traduce a los eventos
  // que el store del kanban consume. El feed entra al bridge por
  // `bridge.ingest`.

  const forwarderSource = path.join(
    context.extensionPath,
    'resources',
    'hooks',
    'orchestrator-hook.cjs',
  );

  const installHooksCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.installHooks',
    () => {
      const result = installHook({ forwarderSource, paths: defaultHookPaths() });
      if (result.status === 'error') {
        channel.appendLine(`[ingester] !!! install failed: ${result.message}`);
        void vscode.window.showErrorMessage(
          `Claude Activity Viewer: hook install failed (${result.message}).`,
        );
        return;
      }
      channel.appendLine(
        `[ingester] hooks ${result.status}: +${result.installed.length} installed, ` +
          `${result.alreadyPresent.length} already present, ${result.skipped.length} skipped. ` +
          `events → ${result.eventsFile}`,
      );
      void vscode.window.showInformationMessage(
        `Claude Activity Viewer: global activity hooks ${result.status}. ` +
          'New Claude Code sessions will stream their agents into the dashboard.',
      );
    },
  );
  context.subscriptions.push(installHooksCmd);

  const uninstallHooksCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.uninstallHooks',
    () => {
      const result = uninstallHook(defaultHookPaths());
      channel.appendLine(
        `[ingester] uninstall: ${result.status} (${result.removed.length} events)`,
      );
      void vscode.window.showInformationMessage(
        `Claude Activity Viewer: global activity hooks ${result.status}.`,
      );
    },
  );
  context.subscriptions.push(uninstallHooksCmd);

  // Deriva project/task/branch del cwd del agente reusando la lógica del
  // dashboard. Variante CON git: un fork por nacimiento de agente es
  // barato (a diferencia del session scanner, que hace cientos por scan).
  const deriveContext = (cwd: string) => {
    const projectsRoot = vscode.workspace
      .getConfiguration('claudeOrchestrator')
      .get<string[]>('projectsRoot', [])
      .map(expandUserHome);
    const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map(
      (f) => f.uri.fsPath,
    );
    return deriveProjectContext(cwd, projectsRoot, undefined, workspaceFolders);
  };

  // Log verboso opt-in del feed traducido (diagnóstico). El ingester
  // corre siempre; este flag solo decide si además loguea cada evento.
  const ingesterDebug = vscode.workspace
    .getConfiguration('claudeOrchestrator')
    .get<boolean>('ingesterDebug', false);

  const hookPaths = defaultHookPaths();
  const ingester = createFileIngester({
    eventsFile: hookPaths.eventsFile,
    deriveContext,
    onEvents: (events) => {
      for (const e of events) {
        bridge.ingest(e);
        if (ingesterDebug) {
          channel.appendLine(`[ingester] ${describeIngestEvent(e)}`);
        }
      }
    },
    log: (msg) => channel.appendLine(msg),
  });
  ingester.start();
  context.subscriptions.push({ dispose: () => ingester.dispose() });
  channel.appendLine(`[ingester] tailing ${hookPaths.eventsFile}`);
}

/** Resumen compacto de un evento traducido, para el log de diagnóstico. */
function describeIngestEvent(e: DashboardEventToWebview): string {
  switch (e.type) {
    case 'agent_created':
      return `created ${e.agent.id} (${e.agent.name}) proj=${e.agent.project}`;
    case 'agent_status_changed':
      return (
        `status ${e.agentId} → ${e.status}` +
        (e.metadata?.currentTool ? ` tool=${e.metadata.currentTool}` : '')
      );
    case 'agent_log':
      return (
        `log ${e.agentId} ${e.entry.kind}` +
        (e.entry.name ? ` ${e.entry.name}` : '')
      );
    case 'agent_completed':
      return (
        `completed ${e.agentId} ${e.result.status}` +
        (e.result.durationMs !== undefined ? ` ${e.result.durationMs}ms` : '')
      );
    default:
      return e.type;
  }
}

/**
 * Hook de desactivación. No-op intencional: todos los recursos vivos
 * están en `context.subscriptions` y los dispone VS Code automáticamente.
 */
export function deactivate(): void {}
