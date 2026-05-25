import type { AgentResult, AgentRunConfig } from './types';

// El SDK de Anthropic es ESM-only (sdk.mjs). El extension host de VS Code
// es CommonJS, así que el módulo solo se puede traer con dynamic import.
// Aliasamos el type para no perder inferencia cuando llamemos `sdk.query`.
// El `with { 'resolution-mode': 'import' }` es requisito de TS 5+ con
// moduleResolution Node16 cuando se referencia un paquete ESM desde CJS.
type SdkModule = typeof import(
  '@anthropic-ai/claude-agent-sdk',
  { with: { 'resolution-mode': 'import' } }
);

/**
 * Runner one-shot de un agente Claude vía claude-agent-sdk.
 *
 * Cada invocación de `startAgent` corresponde a una sesión nueva del CLI.
 * No mantiene estado entre llamadas más allá del módulo SDK ya cargado en
 * memoria (caché lazy para reusar en arranques siguientes).
 *
 * Sin coordinación entre agentes, sin persistencia, sin retry: cubre el
 * caso "un agente, una pregunta, una respuesta" como bloque mínimo sobre
 * el que se construye el resto del orquestador.
 */
export class AgentRunner {
  private sdk: SdkModule | null = null;

  async startAgent(config: AgentRunConfig): Promise<AgentResult> {
    const startTime = Date.now();

    // Acumuladores de la corrida. Se exponen en el AgentResult final y se
    // emiten por onEvent({type:'usage'}) cuando el SDK reporta `result`.
    let status: AgentResult['status'] = 'completed';
    let finalResponse: string | null = null;
    let toolCallCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let costUsd = 0;

    // === Abort wiring ===
    // El SDK toma su propio AbortController en `options.abortController`.
    // El caller pasa un AbortSignal externo; lo "puenteamos" al interno
    // para no exponer detalles del SDK hacia arriba. El listener se
    // remueve en `finally` para no fugar referencias.
    const sdkAbortController = new AbortController();
    const onAbort = () => sdkAbortController.abort();
    config.abortSignal.addEventListener('abort', onAbort, { once: true });

    // Bail-out si el caller canceló incluso antes de arrancar.
    if (config.abortSignal.aborted) {
      config.abortSignal.removeEventListener('abort', onAbort);
      config.onEvent({ type: 'status', status: 'cancelled' });
      return {
        status: 'cancelled',
        finalResponse: null,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      };
    }

    config.onEvent({ type: 'status', status: 'running' });

    try {
      // Lazy load del SDK. Cachear en `this.sdk` evita re-importar en
      // arranques subsecuentes (cuando un runner sea reutilizado).
      if (!this.sdk) {
        this.sdk = await import('@anthropic-ai/claude-agent-sdk');
      }

      // === SDK invocation ===
      // Opciones mínimas iniciales:
      //   - model 'sonnet': nombre corto que el SDK resuelve al snapshot
      //     vigente. Si queremos pin, se pasa el id completo.
      //   - tools preset 'claude_code': habilita todo el toolset por
      //     defecto (Read/Edit/Bash/Grep/etc.).
      //   - permissionMode 'bypassPermissions' + allowDangerouslySkipPermissions:
      //     el SDK exige el flag explícito cuando se usa este modo (ver
      //     sdk.d.ts:1587). Sin prompts interactivos; aceptable porque el
      //     comando corre headless desde la paleta con prompt fijo.
      //     Tightenear cuando entren prompts del usuario en lugar de prompts fijos.
      //   - settingSources ['user']: hereda skills y memoria del usuario
      //     (~/.claude/), no del workspace activo. Coherente con la idea
      //     "ventana del orquestador es global, no por proyecto".
      const generator = this.sdk.query({
        prompt: config.prompt,
        options: {
          cwd: config.cwd,
          model: 'sonnet',
          tools: { type: 'preset', preset: 'claude_code' },
          abortController: sdkAbortController,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: ['user'],
        },
      });

      // === Event dispatch ===
      // El generator es `AsyncGenerator<SDKMessage, void>` (ver Query en
      // sdk.d.ts), así que el switch sobre `event.type` se narrow-a a la
      // variante correcta sin casts. Variantes desconocidas (system,
      // status, hook, etc.) caen al default y se ignoran (forward-compat).
      for await (const event of generator) {
        // Chequeo activo de cancelación: el SDK puede demorar en honrar
        // el abort de su lado, así que cortamos el loop nosotros también.
        if (config.abortSignal.aborted) {
          status = 'cancelled';
          break;
        }

        switch (event.type) {
          case 'stream_event': {
            // Solo nos interesa el delta de thinking para streaming en
            // vivo del razonamiento extendido. El texto final del agente
            // se captura en el caso `assistant` (ya viene agregado).
            const streamEvent = event.event;
            if (streamEvent.type === 'content_block_delta') {
              const delta = streamEvent.delta;
              if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                config.onEvent({ type: 'thinking', text: delta.thinking });
              }
            }
            break;
          }
          case 'assistant': {
            // Mensaje del agente con bloques `text` (respuesta) y/o
            // `tool_use` (invocaciones a herramientas). Procesados en orden.
            // finalResponse acumula TODOS los text blocks del mensaje
            // (separados por \n) en vez de quedarse solo con el último;
            // mensajes consecutivos sí sobreescriben (la última respuesta
            // de la sesión es la que cuenta).
            const content = event.message.content;
            if (!content) break;
            const messageTexts: string[] = [];
            for (const block of content) {
              if (block.type === 'text' && typeof block.text === 'string') {
                messageTexts.push(block.text);
                config.onEvent({ type: 'text', text: block.text });
              } else if (block.type === 'tool_use' && typeof block.name === 'string') {
                toolCallCount++;
                config.onEvent({ type: 'tool_use', name: block.name, input: block.input });
              }
            }
            if (messageTexts.length > 0) {
              finalResponse = messageTexts.join('\n');
            }
            break;
          }
          case 'user': {
            // Los `user` del stream NO son input del usuario humano: son
            // los `tool_result` que retornan al agente tras cada tool_use.
            // Los reemitimos al UI para mostrar qué devolvió cada tool.
            const content = event.message.content;
            if (!Array.isArray(content)) break;
            for (const block of content) {
              if (block.type === 'tool_result') {
                const resultContent = block.content;
                config.onEvent({
                  type: 'tool_result',
                  toolUseId: block.tool_use_id,
                  result: typeof resultContent === 'string'
                    ? resultContent
                    : JSON.stringify(resultContent),
                  isError: block.is_error === true,
                });
              }
            }
            break;
          }
          case 'result': {
            // SDKResultMessage es union de Success | Error. Solo Success
            // trae usage y total_cost_usd; en Error mantenemos los
            // acumuladores como estaban (suelen ser 0 si erró temprano).
            // NO cerramos el generator aquí: el SDK lo cierra solo.
            if (event.subtype === 'success') {
              const usage = event.usage;
              inputTokens = usage.input_tokens ?? inputTokens;
              outputTokens = usage.output_tokens ?? outputTokens;
              cacheReadTokens = usage.cache_read_input_tokens ?? cacheReadTokens;
              cacheCreationTokens = usage.cache_creation_input_tokens ?? cacheCreationTokens;
              costUsd = event.total_cost_usd;
            }
            config.onEvent({
              type: 'usage',
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheCreationTokens,
              costUsd,
            });
            break;
          }
          default: {
            // Variantes no manejadas (system, status, hook, etc.) se
            // ignoran intencionalmente. Forward-compat con nuevas
            // categorías de SDKMessage que el SDK pueda introducir.
            break;
          }
        }
      }
    } catch (err) {
      // Si el caller pidió abort, la excepción del SDK es esperada (suele
      // ser AbortError). Si no, es failure real y reportamos el mensaje.
      if (config.abortSignal.aborted) {
        status = 'cancelled';
      } else {
        status = 'failed';
        finalResponse = err instanceof Error ? err.message : String(err);
      }
    } finally {
      config.abortSignal.removeEventListener('abort', onAbort);
    }

    const durationMs = Date.now() - startTime;
    config.onEvent({ type: 'status', status });
    return {
      status,
      finalResponse,
      toolCallCount,
      durationMs,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      costUsd,
    };
  }
}
