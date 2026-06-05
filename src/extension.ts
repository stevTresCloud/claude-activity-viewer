import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerTestAgentCommands } from './commands/test-agent';
import { AgentRunner } from './runtime/agent-runner';
import { OrchestratorHttpServer } from './mcp/http-transport';
import { registerInClaudeCodeConfig } from './mcp/auto-register';
import {
  injectIntoClaudeMdFile,
  injectAuto,
  type InjectFileResult,
} from './mcp/claude-md-injector';
import { DashboardViewProvider } from './views/dashboard';
import { DetailPanelManager } from './views/detail-panel';
import { DashboardBridge } from './dashboard/bridge';
import { ScannerController } from './dashboard/scanner-controller';
import { FOCUS_DASHBOARD_COMMAND, StatusBarManager } from './dashboard/status-bar';
import { CompletionNotifier } from './dashboard/completion-notifier';
import { deriveProjectContext } from './dashboard/bridge';
import { expandUserHome } from './dashboard/project-scanner';
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

// Metadata expuesta al MCP client cuando hace handshake. El name acá es lo
// que aparece en `claude mcp list` del chat externo; coordina con la entry
// de ~/.claude.json del user.
const MCP_SERVER_NAME = 'claude-orchestrator';
const MCP_SERVER_VERSION = '0.1.0';
const MCP_PORT = 39127;

// Clave usada en VS Code Secret Storage para persistir el bearer token del
// MCP server entre arranques. La API `context.secrets` es per-extensión y
// encripta en disco usando el keystore del SO.
const MCP_TOKEN_SECRET_KEY = 'mcp.bearerToken';
const FIRST_AUTO_REGISTER_TOAST_KEY = 'mcp.autoRegisterToastShown';

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

  // === Auto-registro en el config de Claude Code CLI (~/.claude.json) ===
  // Sin esto, el user tendría que copiar el `claude mcp add-json` del
  // OutputChannel y pegarlo en una terminal externa — fricción real que
  // mata adopción. El helper hace el merge directo, idempotente, atómico,
  // preservando otros MCP servers. Opt-out via setting autoRegisterMcp.
  // Si el config no existe (Claude Code CLI no instalado) o el merge falla,
  // caemos al flow manual (imprimir el comando) sin romper la activación.
  const autoRegister = vscode.workspace
    .getConfiguration('claudeOrchestrator')
    .get<boolean>('autoRegisterMcp', true);

  const runAutoRegister = async (
    quiet: boolean,
  ): Promise<'registered' | 'unchanged' | 'skipped' | 'error'> => {
    const result = await registerInClaudeCodeConfig(bearerToken!, MCP_PORT);
    if (result.status === 'registered') {
      channel.appendLine(
        '[mcp] auto-registered claude-orchestrator in ~/.claude.json (Claude Code config).',
      );
      const alreadyToasted = context.globalState.get<boolean>(
        FIRST_AUTO_REGISTER_TOAST_KEY,
        false,
      );
      if (!quiet && !alreadyToasted) {
        void vscode.window.showInformationMessage(
          'Claude Orchestrator: MCP server registered in Claude Code automatically.',
        );
        await context.globalState.update(FIRST_AUTO_REGISTER_TOAST_KEY, true);
      } else if (!quiet) {
        void vscode.window.showInformationMessage(
          'Claude Orchestrator: MCP server re-registered in Claude Code.',
        );
      }
      return 'registered';
    }
    if (result.status === 'unchanged') {
      channel.appendLine(
        '[mcp] auto-register no-op: entry already up to date in ~/.claude.json.',
      );
      if (!quiet) {
        void vscode.window.showInformationMessage(
          'Claude Orchestrator: MCP server already registered in Claude Code (unchanged).',
        );
      }
      return 'unchanged';
    }
    if (result.status === 'skipped') {
      channel.appendLine(
        '[mcp] auto-register skipped: ~/.claude.json not found (Claude Code CLI may not be installed).',
      );
      if (!quiet) {
        void vscode.window.showWarningMessage(
          'Claude Orchestrator: cannot find ~/.claude.json — install the Claude Code CLI first, then re-run "Register MCP in Claude Code".',
        );
      }
      return 'skipped';
    }
    channel.appendLine(`[mcp] !!! auto-register failed: ${result.message}`);
    if (!quiet) {
      void vscode.window.showErrorMessage(
        `Claude Orchestrator: auto-register failed (${result.message}). Use the manual claude mcp add-json command from the output channel.`,
      );
    }
    return 'error';
  };

  if (autoRegister) {
    void runAutoRegister(true);
  } else {
    channel.appendLine(
      '[mcp] auto-register disabled by claudeOrchestrator.autoRegisterMcp=false.',
    );
  }

  // Comando palette para re-registrar manualmente (útil si el user borró
  // ~/.claude.json, rotó el token, o tenía autoRegisterMcp=false).
  const registerMcpCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.registerMcp',
    () => void runAutoRegister(false),
  );
  context.subscriptions.push(registerMcpCmd);

  // === Auto-inyección de directiva en CLAUDE.md de workspaces ===
  // Sin esto el chat caller invoca spawn_agents ~80% del tiempo (depende
  // del modelo). Con la sección embebida en el CLAUDE.md de cada
  // workspace bajo projectsRoot, el modelo lo lee como contexto del
  // proyecto y la elección se vuelve determinista. Solo updatea
  // CLAUDE.md ya existentes (modo auto); creación explícita via comando
  // palette.

  const summarizeInjection = (results: InjectFileResult[]): string => {
    const tally: Record<string, number> = {};
    for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
    const parts: string[] = [];
    for (const k of ['updated', 'created', 'unchanged', 'skipped', 'error']) {
      if (tally[k]) parts.push(`${tally[k]} ${k}`);
    }
    return parts.join(', ') || 'no files matched';
  };

  const runAutoInject = async (
    createIfMissing: boolean,
    quiet: boolean,
  ): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration('claudeOrchestrator');
    const projectsRoot = cfg.get<string[]>('projectsRoot', []);
    // Workspace folders activos de VS Code. Es la fuente MÁS importante:
    // típicamente el user abre el repo raíz (ej. ~/git19) y el CLAUDE.md
    // vive ahí, no en subdirectorios del projectsRoot. Sin esto el
    // injector falla silenciosamente cuando projectsRoot apunta a un
    // padre genérico (`~/git19/docs`) cuyos subdirs no tienen CLAUDE.md
    // propios.
    const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map(
      (f) => f.uri.fsPath,
    );
    if (projectsRoot.length === 0 && workspaceFolders.length === 0) {
      if (!quiet) {
        void vscode.window.showInformationMessage(
          'Claude Orchestrator: no projectsRoot configured and no workspace open. Add absolute paths in settings or open a workspace first.',
        );
      }
      channel.appendLine(
        '[claude-md] auto-inject skipped: no projectsRoot configured and no workspace folder open.',
      );
      return;
    }
    const summary = await injectAuto(projectsRoot, workspaceFolders, {
      createIfMissing,
    });
    const summaryStr = summarizeInjection(summary.results);
    channel.appendLine(
      `[claude-md] scanned ${summary.scannedRoots.length} root(s) (workspace folders + projectsRoot subdirs); ${summaryStr}.`,
    );
    for (const r of summary.results) {
      if (r.status === 'error') {
        channel.appendLine(`[claude-md] !!! ${r.path}: ${r.reason}`);
      } else if (r.status === 'updated' || r.status === 'created') {
        channel.appendLine(`[claude-md] ${r.status}: ${r.path}`);
      }
    }
    if (!quiet) {
      const touched = summary.results.filter(
        (r) => r.status === 'updated' || r.status === 'created',
      );
      if (touched.length === 0) {
        void vscode.window.showInformationMessage(
          'Claude Orchestrator: no CLAUDE.md files needed updating (already up to date or none found in workspace folders / projectsRoot).',
        );
      } else if (touched.length <= 3) {
        // Pocas rutas → caben inline en el toast. Nombre relativo al
        // home para que no se vea ruidoso con paths absolutos largos.
        const pretty = touched
          .map((r) => relativizeToHome(r.path))
          .join(', ');
        void vscode.window.showInformationMessage(
          `Claude Orchestrator: ${touched.length} CLAUDE.md file${touched.length === 1 ? '' : 's'} updated: ${pretty}`,
        );
      } else {
        // Muchas rutas → resumen + "Show details" que enfoca el output
        // channel donde cada path quedó loggeada arriba.
        const message = `Claude Orchestrator: ${touched.length} CLAUDE.md files updated.`;
        const action = await vscode.window.showInformationMessage(
          message,
          'Show details',
        );
        if (action === 'Show details') {
          channel.show(true);
        }
      }
    }
  };

  // Helper local: convierte `/home/me/foo/bar` → `~/foo/bar` para
  // mostrar paths en el toast sin desperdiciar espacio. Solo cosmético
  // para humanos; el output channel mantiene el path absoluto.
  function relativizeToHome(p: string): string {
    const home = process.env.HOME ?? '';
    if (home && p.startsWith(home + '/')) {
      return '~' + p.slice(home.length);
    }
    return p;
  }

  const autoInject = vscode.workspace
    .getConfiguration('claudeOrchestrator')
    .get<boolean>('autoInjectClaudeMd', true);
  if (autoInject) {
    void runAutoInject(false, true);
  } else {
    channel.appendLine(
      '[claude-md] auto-inject disabled by claudeOrchestrator.autoInjectClaudeMd=false.',
    );
  }

  // Re-inject cuando `projectsRoot` cambia (user agrega/quita paths) o
  // cuando `autoInjectClaudeMd` flippa a true. NO re-inyecta cuando
  // autoInjectClaudeMd flippa a false (no destructivo — la sección
  // existente queda hasta que el user la borre manualmente).
  const settingsListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration('claudeOrchestrator.projectsRoot') ||
      event.affectsConfiguration('claudeOrchestrator.autoInjectClaudeMd')
    ) {
      const stillAuto = vscode.workspace
        .getConfiguration('claudeOrchestrator')
        .get<boolean>('autoInjectClaudeMd', true);
      if (stillAuto) {
        void runAutoInject(false, true);
      }
    }
  });
  context.subscriptions.push(settingsListener);

  // Comando palette manual. Pregunta si crear CLAUDE.md faltantes —
  // sin opciones del workspace activo, escanea projectsRoot completo.
  const injectClaudeMdCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.injectClaudeMd',
    async () => {
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: 'Update existing CLAUDE.md only',
            description: 'Skip subdirectories that do not have CLAUDE.md',
            value: false,
          },
          {
            label: 'Update existing + create missing',
            description: 'Create CLAUDE.md in every direct subfolder of projectsRoot',
            value: true,
          },
        ],
        {
          title: 'Inject MCP directive into workspaces',
          placeHolder: 'How to handle subdirectories without CLAUDE.md?',
        },
      );
      if (!pick) return;
      await runAutoInject(pick.value, false);
    },
  );
  context.subscriptions.push(injectClaudeMdCmd);

  // Helper exportado por el comando para inyectar en un archivo
  // específico (no usado hoy por la UI pero queda disponible si el
  // futuro detail panel quiere ofrecer "inject here" por workspace).
  void injectIntoClaudeMdFile;

  // Fallback manual: el comando exacto siempre va al output channel. Si
  // el auto-register falla por cualquier razón (config ausente, parse
  // error, perms), el user todavía puede copiar y pegar.
  const mcpAddJsonPayload = JSON.stringify({
    type: 'http',
    url: `http://127.0.0.1:${MCP_PORT}/mcp`,
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  channel.appendLine(
    '[mcp] manual setup fallback (if auto-register did not run):\n' +
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
    if (msg.type === 'request_run_test_agent') {
      void vscode.commands.executeCommand('claudeOrchestrator.testAgent');
      return;
    }
    if (msg.type === 'request_inject_claude_md') {
      // Atajo del botón del toolbar: ejecuta auto-inject sin prompt
      // (createIfMissing=false). Para crear archivos faltantes el user
      // tiene el comando palette completo con QuickPick.
      void runAutoInject(false, false);
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

  // ====================================================================
  // === Activity viewer ingester (scaffold) ============================
  // ====================================================================
  // Motor read-only del viewer: escucha la actividad de los agentes de
  // Claude Code vía hooks globales y la traduce a los eventos que el
  // store del kanban ya consume. Por ahora el sink es el OutputChannel
  // (smoke); el siguiente paso lo reconecta al bridge/store y retira el
  // resto del orquestador. Bloque aislado: NO toca el wiring MCP/bridge.

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
          `Claude Orchestrator: hook install failed (${result.message}).`,
        );
        return;
      }
      channel.appendLine(
        `[ingester] hooks ${result.status}: +${result.installed.length} installed, ` +
          `${result.alreadyPresent.length} already present, ${result.skipped.length} skipped. ` +
          `events → ${result.eventsFile}`,
      );
      void vscode.window.showInformationMessage(
        `Claude Orchestrator: global activity hooks ${result.status}. ` +
          'Enable claudeOrchestrator.ingesterDebug and reload to tail the stream.',
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
        `Claude Orchestrator: global activity hooks ${result.status}.`,
      );
    },
  );
  context.subscriptions.push(uninstallHooksCmd);

  // Tail opt-in: solo cuando ingesterDebug=true. Deriva project/task/
  // branch del cwd reusando la lógica del dashboard (con ~ expandido en
  // projectsRoot, igual que el bridge).
  const ingesterDebug = vscode.workspace
    .getConfiguration('claudeOrchestrator')
    .get<boolean>('ingesterDebug', false);
  if (ingesterDebug) {
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
    const hookPaths = defaultHookPaths();
    const ingester = createFileIngester({
      eventsFile: hookPaths.eventsFile,
      deriveContext,
      onEvents: (events) => {
        for (const e of events) {
          channel.appendLine(`[ingester] ${describeIngestEvent(e)}`);
        }
      },
      log: (msg) => channel.appendLine(msg),
    });
    ingester.start();
    context.subscriptions.push({ dispose: () => ingester.dispose() });
    channel.appendLine(`[ingester] debug tail started on ${hookPaths.eventsFile}`);
  }
}

/** Resumen compacto de un evento traducido, para el log del smoke. */
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
      return `completed ${e.agentId} ${e.result.status} ${e.result.durationMs}ms`;
    default:
      return e.type;
  }
}

/**
 * Hook de desactivación. No-op intencional: todos los recursos vivos
 * (channel, commands, listeners, bridge) están en `context.subscriptions`
 * y los dispose VS Code automáticamente al desactivar la extensión.
 */
export function deactivate(): void {}
