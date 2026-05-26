import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { registerTestAgentCommands } from './commands/test-agent';
import { AgentRunner } from './runtime/agent-runner';
import { OrchestratorHttpServer } from './mcp/http-transport';
import { DashboardViewProvider } from './views/dashboard';
import { DetailPanelManager } from './views/detail-panel';
import { DashboardBridge } from './dashboard/bridge';
import { ScannerController } from './dashboard/scanner-controller';
import { FOCUS_DASHBOARD_COMMAND, StatusBarManager } from './dashboard/status-bar';
import { CompletionNotifier } from './dashboard/completion-notifier';
import type { DashboardEventToExtension } from './shared/dashboard-protocol';

// Metadata expuesta al MCP client cuando hace handshake. El name acá es lo
// que aparece en `claude mcp list` del chat externo; coordina con la entry
// de ~/.claude/mcp.json del user.
const MCP_SERVER_NAME = 'claude-orchestrator';
const MCP_SERVER_VERSION = '0.0.1';

// Clave usada en VS Code Secret Storage para persistir el bearer token del
// MCP server entre arranques. La API `context.secrets` es per-extensión y
// encripta en disco usando el keystore del SO.
const MCP_TOKEN_SECRET_KEY = 'mcp.bearerToken';

/**
 * Punto de entrada de la extensión Claude Orchestrator.
 *
 * `activate` se dispara cuando VS Code resuelve cualquier
 * `activationEvent` declarado en el package.json (o cuando el usuario
 * invoca un comando contribuido). Registra los comandos, crea el
 * OutputChannel compartido, instancia el bridge del dashboard y
 * arranca el MCP server HTTP local.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // OutputChannel compartido para todo el extension host. Vive en
  // context.subscriptions para que VS Code lo libere al desactivar.
  const channel = vscode.window.createOutputChannel('Claude Orchestrator');
  context.subscriptions.push(channel);

  // Comando smoke histórico: confirma que el extension host nos puede
  // disparar comandos. Útil para validar el setup desde EDH sin tocar
  // la integración con el SDK.
  const helloCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.hello',
    () => {
      vscode.window.showInformationMessage('Claude Orchestrator activo.');
    },
  );
  context.subscriptions.push(helloCmd);

  // Runner único compartido entre los comandos del palette y el MCP server.
  // Cachea el dynamic import del SDK Anthropic; reusarlo evita pagar la
  // carga del módulo cada vez que arranca un agente.
  const runner = new AgentRunner();

  // === Bridge: registry + supervisor + persistencia ===
  // Punto de entrada único para "lanzar y observar agentes". Tanto
  // palette commands como MCP handler pasan por bridge.spawn — nunca
  // llaman runner.startAgent directo. Esto centraliza eventos al
  // webview, persistencia en globalState y derivación de project/task.
  const bridge = new DashboardBridge({ context, channel, runner });
  await bridge.hydrate();

  // Comandos del runner: lanzar y cancelar un agente de prueba.
  registerTestAgentCommands(context, channel, bridge);

  // === Bearer token del MCP server ===
  // Lo persistimos en context.secrets para reusar el mismo token entre
  // arranques (así el user configura `claude mcp add` una sola vez). Si
  // no existe, generamos uno aleatorio de 256 bits.
  // Sin auth, cualquier proceso local podría invocar spawn_agents y gastar
  // crédito Anthropic + ejecutar Bash arbitrario vía bypassPermissions.
  let bearerToken = await context.secrets.get(MCP_TOKEN_SECRET_KEY);
  if (!bearerToken) {
    bearerToken = crypto.randomBytes(32).toString('hex');
    await context.secrets.store(MCP_TOKEN_SECRET_KEY, bearerToken);
    channel.appendLine(
      '[mcp] generated new bearer token (persistido en VS Code Secret Storage).',
    );
  }

  // Mostramos el comando exacto que el user debe pegar en su terminal
  // para registrar el server en Claude Code. Usamos `add-json` en vez de
  // `add` porque el `--header` de `claude mcp add` es variadic y se traga
  // los argumentos posicionales (`name`, `url`) como header values más,
  // dejando el comando inválido. `add-json` recibe un solo JSON literal
  // y evita ese problema de parsing.
  const mcpAddJsonPayload = JSON.stringify({
    type: 'http',
    url: 'http://127.0.0.1:39127/mcp',
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  channel.appendLine(
    '[mcp] register in Claude Code (run once per machine):\n' +
      `       claude mcp add-json --scope user claude-orchestrator '${mcpAddJsonPayload}'`,
  );

  // === MCP server embedded ===
  // Arrancamos en activate() en background. Si el puerto está en uso
  // (segunda EDH) el OrchestratorHttpServer loggea warning y skipea el
  // bind; la extensión sigue funcional para los comandos del palette.
  // Por eso el await/catch va aislado y NO bloquea activate().
  const httpServer = new OrchestratorHttpServer({
    channel,
    bridge,
    bearerToken,
    serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
  });

  httpServer.start().catch((err) => {
    channel.appendLine(
      `[mcp] !!! failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  // Disposable: VS Code llama esto al desactivar la extensión. dispose es
  // async pero context.subscriptions acepta sync; lanzamos sin esperar y
  // confiamos en que el process exit es suficiente para liberar el socket.
  context.subscriptions.push({
    dispose: () => {
      httpServer.dispose().catch((err) => {
        channel.appendLine(
          `[mcp] !!! dispose error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      // Bridge cancela agentes vivos + flush final de persistencia.
      bridge.dispose().catch((err) => {
        channel.appendLine(
          `[bridge] !!! dispose error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
  });

  // === Scanner controller ===
  // Orquesta los scanners de proyectos + sesiones, su auto-refresh
  // y el handler de Resume. Arrancamos post-hydrate para que el
  // primer scan vea los agentes vivos del state persistido (no se
  // dupliquen en PAST SESSIONS si la sesión sigue corriendo).
  const scanner = new ScannerController({ context, channel, bridge });
  scanner.start();
  context.subscriptions.push({ dispose: () => scanner.stop() });

  // Comando palette: re-scan manual. Útil cuando el user agrega un
  // proyecto al filesystem y no quiere esperar al próximo tick.
  const rescanCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.rescan',
    () => {
      void scanner.rescan('manual');
    },
  );
  context.subscriptions.push(rescanCmd);

  // === Status bar item con conteo de agentes running ===
  // Muestra `$(rocket) N agents` cuando hay 1+ corriendo, hidden
  // cuando no hay nada. Click salta al sidebar. Cumple UC-06 del
  // DESIGN.md ("ver el conteo de agentes activos en la status bar").
  const statusBar = new StatusBarManager(bridge);
  context.subscriptions.push(statusBar);

  const focusDashboardCmd = vscode.commands.registerCommand(
    FOCUS_DASHBOARD_COMMAND,
    () => {
      // El viewContainer id del package.json es `claudeOrchestrator`.
      // VS Code expone el comando bien conocido
      // `workbench.view.extension.<id>` para enfocarlo. Sin args,
      // abre el panel y selecciona la primera vista del container
      // (nuestra `claudeOrchestrator.dashboard`).
      void vscode.commands.executeCommand(
        'workbench.view.extension.claudeOrchestrator',
      );
    },
  );
  context.subscriptions.push(focusDashboardCmd);

  // === Detail panel (editor tab) ===
  // Abre on-demand cuando el user clickea el body de una card del
  // sidebar (event `request_show_detail`). Single-instance: si ya
  // hay panel abierto para otro agente, el manager lo dispose y
  // crea uno nuevo para el agentId actual.
  const detailPanel = new DetailPanelManager(
    context.extensionUri,
    bridge,
    channel,
    (msg) => scanner.handleMessage(msg),
  );
  context.subscriptions.push(detailPanel);

  // === Completion notifier ===
  // Toast VS Code "Agent X finished" cuando un agente termina.
  // Click "Open detail" → abre el detail panel para ese agente.
  // Opt-out via setting `claudeOrchestrator.notifyOnComplete`.
  const completionNotifier = new CompletionNotifier({
    bridge,
    channel,
    showDetail: (agentId, name) => detailPanel.showForAgent(agentId, name),
  });
  context.subscriptions.push(completionNotifier);

  // === Handler webview→ext del `request_show_detail` ===
  // Lo separamos del scanner-controller porque el manager del
  // detail panel vive en views/, no en dashboard/. Wireamos un
  // proxy del scanner.handleMessage que intercepta el show_detail
  // y delega el resto al scanner.
  const handleWebviewMessage = (msg: DashboardEventToExtension): void => {
    if (msg.type === 'request_show_detail') {
      const meta = bridge.getResumeTarget(msg.agentId);
      const name = meta?.name ?? msg.agentId.slice(0, 8);
      detailPanel.showForAgent(msg.agentId, name);
      return;
    }
    scanner.handleMessage(msg);
  };

  // === Dashboard webview (sidebar) ===
  // Registramos el provider que VS Code instancia cuando el user abre
  // el Activity Bar de Claude Orchestrator. retainContextWhenHidden
  // mantiene vivo el estado de Vue/Pinia mientras el sidebar está
  // colapsado — el costo (~5MB RAM) es preferible a re-hidratar todo
  // cada vez que se reabre.
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
}

/**
 * Hook de desactivación. No-op intencional: todos los recursos vivos
 * (channel, commands, listeners, bridge) están en `context.subscriptions`
 * y los dispose VS Code automáticamente al desactivar la extensión.
 */
export function deactivate(): void {}
