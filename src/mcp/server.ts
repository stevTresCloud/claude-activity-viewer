import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { DashboardBridge } from '../dashboard/bridge';
import { ts } from '../runtime/log';
import { SPAWN_AGENTS_INPUT_SHAPE, type SpawnAgentsArgs } from './types';

export interface OrchestratorMcpServerOptions {
  channel: vscode.OutputChannel;
  serverInfo: { name: string; version: string };
  bridge: DashboardBridge;
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
 *   en localhost.
 *
 * Contrato actual del tool `spawn_agents`:
 *   - Acepta N tasks (max 8 hoy) con cwd obligatorio.
 *   - Lanza cada una vía bridge.spawn (que crea el snapshot, dispara
 *     el AgentRunner en background y emite eventos al webview).
 *   - Retorna INMEDIATAMENTE con `{ batchId, agentIds }`. NO espera a
 *     que los agentes terminen — la observación es vía el dashboard.
 */
export class OrchestratorMcpServer {
  private readonly channel: vscode.OutputChannel;
  private readonly serverInfo: { name: string; version: string };
  private readonly bridge: DashboardBridge;
  private readonly allowedHosts: string[];

  constructor(options: OrchestratorMcpServerOptions) {
    this.channel = options.channel;
    this.serverInfo = options.serverInfo;
    this.bridge = options.bridge;
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
    this.registerSpawnAgents(server);

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
  // Defiere a bridge.spawn (sync return). El bridge agrega el agente al
  // registry, postMessage al webview con agent_created, y arranca la
  // ejecución en background. Retornamos los agentIds para que el caller
  // pueda correlacionar después (ej. esperar al cierre via list_agents
  // cuando esa tool se agregue).
  //
  // batchId compartido entre las N tasks de un mismo call — el dashboard
  // lo usa para agrupar las cards visualmente (project group container
  // por batch).
  private registerSpawnAgents(server: McpServer): void {
    server.registerTool(
      'spawn_agents',
      {
        title: 'Spawn Agents',
        description:
          'Spawnea uno o más agentes Claude Code en paralelo y retorna sus IDs inmediatamente. ' +
          'Los agentes corren en background con el toolset preset claude_code (Read/Edit/Bash/Grep/etc.) ' +
          'y herencia de skills + memoria del usuario (~/.claude/). ' +
          'Observación del progreso vía el dashboard del plugin (sidebar VS Code).',
        inputSchema: SPAWN_AGENTS_INPUT_SHAPE,
      },
      async (args: SpawnAgentsArgs) => {
        const stamp = ts();
        const batchId = `b-${crypto.randomBytes(4).toString('hex')}`;
        this.channel.appendLine(
          `[${stamp}] [mcp] spawn_agents tasks=${args.tasks.length} batch=${batchId}`,
        );

        const agentIds: string[] = [];
        // Si bridge.spawn tira a mitad del loop (ej. fallo en
        // globalState al persistir) los agentIds previos ya están
        // vivos en el registry. Los cancelamos para no dejarlos
        // huérfanos sin que el caller lo sepa, y devolvemos
        // `isError: true` con la lista parcial — el chat externo
        // puede correlacionar IDs con su intento original.
        try {
          for (const task of args.tasks) {
            const { agentId } = this.bridge.spawn({
              name: task.name,
              prompt: task.prompt,
              cwd: task.cwd,
              batchId,
              projectOverride: args.options?.project,
            });
            agentIds.push(agentId);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.channel.appendLine(
            `[${ts()}] [mcp] !!! spawn loop failed after ${agentIds.length}/${args.tasks.length} tasks: ${msg}`,
          );
          for (const id of agentIds) this.bridge.cancel(id);
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    error: msg,
                    batchId,
                    agentIds,
                    cancelled: true,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // Wrap del payload en JSON text (no structuredContent) — soportado
        // por todos los MCP clients hoy.
        const payload = { batchId, agentIds };
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      },
    );
  }
}
