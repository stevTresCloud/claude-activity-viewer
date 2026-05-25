import * as http from 'node:http';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AgentRunner } from '../runtime/agent-runner';
import type { AgentResult } from '../runtime/types';
import { LOG_TRUNCATE_AT, logAgentEvent, ts, truncate } from '../runtime/log';
import { SPAWN_AGENTS_INPUT_SHAPE, type SpawnAgentsArgs } from './types';

export interface OrchestratorMcpServerOptions {
  channel: vscode.OutputChannel;
  serverInfo: { name: string; version: string };
  runner: AgentRunner;
  // Allowed Host header values para la protección DNS rebinding del transport.
  // Lo pasa el http-transport que conoce su propio bind (host:port).
  allowedHosts: string[];
}

/**
 * Orquestador MCP: encapsula la creación de un `McpServer` + transport
 * Streamable HTTP por cada request entrante.
 *
 * Por qué fresh-por-request en vez de un singleton:
 *   El SDK MCP v1.29.0 tiene un bug en stateless mode: tras procesar un
 *   request OK, el `_streamMapping` del transport conserva entries
 *   muertos y el siguiente request explota con 500. Crear instancias
 *   nuevas por call esquiva el bug a costo de microsegundos de overhead
 *   en localhost. El tradeoff es aceptable mientras procesemos UNA tarea
 *   por call; si compartimos transport entre múltiples tasks habrá que
 *   re-evaluar.
 */
export class OrchestratorMcpServer {
  private readonly channel: vscode.OutputChannel;
  private readonly serverInfo: { name: string; version: string };
  private readonly runner: AgentRunner;
  private readonly allowedHosts: string[];

  constructor(options: OrchestratorMcpServerOptions) {
    this.channel = options.channel;
    this.serverInfo = options.serverInfo;
    this.runner = options.runner;
    this.allowedHosts = options.allowedHosts;
  }

  /**
   * Atiende UN request HTTP construyendo McpServer + transport fresh.
   * Garantiza cierre/cleanup en `finally`, así no acumulamos sockets ni
   * listeners aunque el handler tire o el cliente desconecte.
   */
  async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const server = new McpServer(this.serverInfo);
    this.registerSpawnAgents(server, req);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts: this.allowedHosts,
    });

    // Engancha errores internos del transport al OutputChannel. Sin este
    // hook, los errores que el transport reporta vía `onerror` se pierden
    // silenciosamente y el caller solo ve una respuesta 4xx/5xx sin contexto.
    transport.onerror = (err) => {
      this.channel.appendLine(
        `[${ts()}] [mcp] !!! transport error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      );
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      // Orden: transport.close primero (cancela streams abiertos), luego
      // server.close (libera handlers internos del SDK). `catch(() => {})`
      // porque cualquier error de cierre ya no le sirve al cliente y
      // contaminaría el log con falsos positivos.
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }

  async dispose(): Promise<void> {
    // No mantenemos handles persistentes; los instances per-request se
    // limpian en sus propios `finally`. Hook reservado por si más adelante
    // se agrega algún recurso global (cache, métricas, etc.).
  }

  // === Tool: spawn_agents ===
  //
  // Contrato actual: input = { tasks: [{prompt, cwd?}] } con max(1).
  // Sincronía simple: arrancamos UN agente, esperamos a que termine,
  // retornamos su AgentResult serializado como CallToolResult.
  //
  // Por qué retornamos JSON en el `text` del content en vez de
  // `structuredContent`: el cliente Claude Code chat parsea el text
  // como markdown y lo muestra al usuario; structuredContent requiere
  // que el cliente lo soporte explícitamente y a mayo 2026 el comportamiento
  // varía. JSON-stringified en text funciona en cualquier MCP client.
  private registerSpawnAgents(
    server: McpServer,
    req: http.IncomingMessage,
  ): void {
    server.registerTool(
      'spawn_agents',
      {
        title: 'Spawn Agents',
        description:
          'Spawnea uno o más agentes Claude Code en paralelo y retorna sus resultados. ' +
          'Cada agente corre con el toolset preset claude_code (Read/Edit/Bash/Grep/etc.) ' +
          'y herencia de skills + memoria del usuario (~/.claude/).',
        inputSchema: SPAWN_AGENTS_INPUT_SHAPE,
      },
      async (args: SpawnAgentsArgs) => {
        const stamp = ts();
        this.channel.appendLine(
          `[${stamp}] [mcp] spawn_agents called tasks=${args.tasks.length}`,
        );

        // cwd default: primer workspace folder de la EDH si existe; si no,
        // cwd del proceso. El cliente externo puede sobrescribirlo por task.
        const defaultCwd =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

        const task = args.tasks[0];
        const cwd = task.cwd ?? defaultCwd;

        // Si el cliente HTTP cierra antes de que el agente termine,
        // abortamos la corrida para no seguir gastando tokens en una
        // respuesta que ya no va a llegar a ningún lado.
        const abortController = new AbortController();
        const onClientClose = () => abortController.abort();
        req.once('close', onClientClose);

        this.channel.appendLine(
          `[${stamp}] [mcp] >>> spawning prompt=${truncate(JSON.stringify(task.prompt), LOG_TRUNCATE_AT)} cwd=${cwd}`,
        );

        try {
          const result = await this.runner.startAgent({
            prompt: task.prompt,
            cwd,
            abortSignal: abortController.signal,
            onEvent: (event) => logAgentEvent(this.channel, event),
          });

          const endStamp = ts();
          this.channel.appendLine(
            `[${endStamp}] [mcp] <<< spawn_agents done status=${result.status}` +
              ` tools=${result.toolCallCount} duration=${result.durationMs}ms` +
              ` cost=$${result.costUsd.toFixed(4)}`,
          );

          // Envolvemos el AgentResult en `results: []` para que la forma
          // del output ya prevea la futura versión multi-agente. Los
          // clientes pueden iterar results[] desde hoy sin migrar el día
          // que crezca.
          const payload = {
            results: [result satisfies AgentResult],
          };

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(payload, null, 2),
              },
            ],
          };
        } finally {
          req.off('close', onClientClose);
        }
      },
    );
  }
}
