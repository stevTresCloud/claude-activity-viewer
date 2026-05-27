import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { DashboardBridge } from '../dashboard/bridge';
import { ts } from '../runtime/log';
import { secondsToMs } from '../shared/format';
import {
  CANCEL_AGENT_INPUT_SHAPE,
  GET_AGENT_LOG_INPUT_SHAPE,
  LIST_AGENTS_INPUT_SHAPE,
  SPAWN_AGENTS_INPUT_SHAPE,
  WAIT_FOR_AGENTS_INPUT_SHAPE,
  type CancelAgentArgs,
  type GetAgentLogArgs,
  type SpawnAgentsArgs,
  type WaitForAgentsArgs,
} from './types';
import type { WaitForAgentsResult } from '../shared/dashboard-protocol';

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
    this.registerListAgents(server);
    this.registerGetAgentLog(server);
    this.registerCancelAgent(server);
    this.registerWaitForAgents(server);

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
          'Observación del progreso vía el dashboard del plugin (sidebar VS Code).\n\n' +
          'MODEL SELECTION: Each task accepts an optional `model` field with one of ' +
          '"sonnet" (balanced cost/capability — default), "opus" (highest capability, slower, ' +
          'more expensive), or "haiku" (fastest, cheapest). If the user did not specify a model ' +
          'in their request, prefer to ASK them which model to use before spawning expensive ' +
          'long-running agents, especially when the task is exploratory or low-stakes — using ' +
          'haiku or sonnet over opus can save significant cost. If the user already stated a ' +
          'preferred model in the conversation, respect that without re-asking. When omitted, ' +
          'the orchestrator falls back to the user\'s `claudeOrchestrator.defaultModel` setting.',
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
              model: task.model,
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

  // === Tool: list_agents ===
  //
  // Snapshot del registry del bridge. Lo consume el chat externo
  // para preguntas tipo "qué agentes tengo / cómo van". Retorna
  // todos los agentes (vivos + terminados que sobrevivieron al
  // TTL del globalState) en formato wire compacto.
  private registerListAgents(server: McpServer): void {
    server.registerTool(
      'list_agents',
      {
        title: 'List agents',
        description:
          'Lista todos los agentes en el registry del orchestrator (vivos + terminados recientes). ' +
          'Devuelve por cada uno: id, name, status, project, task, branch, model, sessionId opcional, ' +
          'timestamps de inicio/fin, duración, tokens y razón terminal si aplica. ' +
          'Útil para preguntas tipo "qué tengo corriendo" o "cómo terminaron mis agentes".',
        inputSchema: LIST_AGENTS_INPUT_SHAPE,
      },
      async () => {
        const agents = this.bridge.listAgents();
        this.channel.appendLine(
          `[${ts()}] [mcp] list_agents count=${agents.length}`,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ agents }, null, 2),
            },
          ],
        };
      },
    );
  }

  // === Tool: cancel_agent ===
  //
  // Wrapper trivial de `bridge.cancel`. El bridge retorna `boolean`
  // (true = había un AbortController vivo y se disparó; false = no
  // existe o ya terminó). Para el chat externo, `cancelled: false`
  // NO es error — es estado legítimo "el agente ya estaba muerto".
  // Solo excepciones reales del bridge se propagan como `isError`.
  //
  // La lógica vive en `cancelAgent` público para que los tests
  // unitarios puedan ejercer la rama true/false sin levantar
  // McpServer + transport HTTP.

  /**
   * Cancela el agente identificado por `agentId`.
   * Devuelve `{ cancelled, agent_id }`. `cancelled=false` indica
   * que no había agente vivo con ese id (puede haber terminado
   * ya, nunca existido, o estar en otro registry).
   */
  cancelAgent(agentId: string): { cancelled: boolean; agent_id: string } {
    const cancelled = this.bridge.cancel(agentId);
    this.channel.appendLine(
      `[${ts()}] [mcp] cancel_agent agent=${agentId.slice(0, 8)} cancelled=${cancelled}`,
    );
    return { cancelled, agent_id: agentId };
  }

  private registerCancelAgent(server: McpServer): void {
    server.registerTool(
      'cancel_agent',
      {
        title: 'Cancel agent',
        description:
          'Cancela un agente vivo por id. Dispara el AbortController del bridge y el agente entra a status=cancelled. ' +
          'Devuelve `{cancelled, agent_id}`. `cancelled=false` no es error: indica que el agente no estaba vivo ' +
          '(terminó previamente, nunca existió, o pertenece a otro registry). Errores reales del bridge se ' +
          'reportan como isError:true.',
        inputSchema: CANCEL_AGENT_INPUT_SHAPE,
      },
      async (args: CancelAgentArgs) => {
        // try/catch porque la description del tool promete que
        // "errores reales del bridge se reportan como isError:true".
        // Hoy bridge.cancel no tira (solo invoca abort.abort), pero
        // el contrato debe matchear el código aunque la rama no se
        // ejerza en producción — un cambio futuro del bridge puede
        // romper la promesa silentemente sin esto.
        try {
          const payload = this.cancelAgent(args.agent_id);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(payload, null, 2),
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.channel.appendLine(
            `[${ts()}] [mcp] !!! cancel_agent failed: ${msg}`,
          );
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { error: msg, agent_id: args.agent_id },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      },
    );
  }

  // === Tool: wait_for_agents ===
  //
  // Long-poll bloqueante: espera a que todos los agent_ids lleguen
  // a estado terminal o venza timeout_sec. Si vence con pending, el
  // chat re-llama con los pending (patrón retry).
  //
  // El cliente claude-code corta requests >~600s en algunos transports;
  // por eso el shape Zod limita timeout_sec a 1200 max y el caller
  // típico usa el default 300s. Si la tarea real toma 30min, el chat
  // hace 6 calls de 5min cada una — patrón estándar del ecosistema
  // (ver research/MCP_ASYNC_FAN_IN_RESEARCH.md).
  //
  // La lógica vive en `waitForAgents` público para testeo directo.

  /**
   * Espera a los agent_ids con long-poll. Lee `stuckDetectionSec` del
   * setting al momento de la llamada (respeta cambios live de config).
   */
  async waitForAgents(args: WaitForAgentsArgs): Promise<WaitForAgentsResult> {
    const timeoutSec = args.timeout_sec ?? 300;
    const cfg = vscode.workspace.getConfiguration('claudeOrchestrator');
    const stuckSec = cfg.get<number>('stuckDetectionSec', 60);
    this.channel.appendLine(
      `[${ts()}] [mcp] wait_for_agents agents=${args.agent_ids.length} timeoutSec=${timeoutSec} stuckSec=${stuckSec}`,
    );
    return this.bridge.waitForAgents({
      agentIds: args.agent_ids,
      timeoutMs: secondsToMs(timeoutSec),
      stuckThresholdMs: secondsToMs(stuckSec),
    });
  }

  private registerWaitForAgents(server: McpServer): void {
    server.registerTool(
      'wait_for_agents',
      {
        title: 'Wait for agents',
        description:
          'Bloquea hasta que todos los agent_ids alcancen estado terminal (done/failed/cancelled) ' +
          'o venza timeout_sec (default 300s, max 1200s). Devuelve `results` para terminados + ' +
          '`pending` para los que siguen corriendo (con `last_message_partial` y `suspected_stuck`). ' +
          '\n\nPATRÓN RETRY: si `timed_out: true` y `pending` tiene items, re-llamar la tool con ' +
          'los pending agent_ids para seguir esperando. Repetir hasta que `pending` quede vacío o ' +
          'decidir cancelar con cancel_agent.\n\n' +
          'NOTAS: para tareas ligeras (consulta web, código corto) usar timeout_sec=30-60. Para ' +
          'tareas pesadas (migraciones, audits) usar 600-1200. El plugin tiene un cap defensivo ' +
          'global (`claudeOrchestrator.maxAgentRuntimeSec`, default 2000s) que cancela agentes ' +
          'que viven más de eso con `reason: max_runtime_exceeded`.',
        inputSchema: WAIT_FOR_AGENTS_INPUT_SHAPE,
      },
      async (args: WaitForAgentsArgs) => {
        try {
          const payload = await this.waitForAgents(args);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(payload, null, 2),
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.channel.appendLine(
            `[${ts()}] [mcp] !!! wait_for_agents failed: ${msg}`,
          );
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { error: msg, agent_ids: args.agent_ids },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      },
    );
  }

  // === Tool: get_agent_log ===
  //
  // Ringbuffer de logs del agente (max 1000 entries FIFO). Si
  // `since` viene, filtra por timestamp para que el chat externo
  // pueda paginar incremental — guarda el ts del último entry
  // recibido y pide el delta en la próxima call.
  private registerGetAgentLog(server: McpServer): void {
    server.registerTool(
      'get_agent_log',
      {
        title: 'Get agent log',
        description:
          'Devuelve los eventos del log de un agente (thinking, text, tool_use, tool_result, usage). ' +
          'Ringbuffer de 1000 entries FIFO del bridge. ' +
          'Argumentos: agent_id (required), since (opcional, epoch ms para paginación incremental). ' +
          'Si el agentId no existe, retorna `{error: "agent_not_found", agent_id}`.',
        inputSchema: GET_AGENT_LOG_INPUT_SHAPE,
      },
      async (args: GetAgentLogArgs) => {
        const result = this.bridge.getAgentLog(args.agent_id, args.since);
        if (!result) {
          this.channel.appendLine(
            `[${ts()}] [mcp] get_agent_log agent=${args.agent_id.slice(0, 8)} not_found`,
          );
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { error: 'agent_not_found', agent_id: args.agent_id },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        this.channel.appendLine(
          `[${ts()}] [mcp] get_agent_log agent=${args.agent_id.slice(0, 8)} entries=${result.entries.length}${args.since !== undefined ? ` since=${args.since}` : ''}`,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );
  }
}
