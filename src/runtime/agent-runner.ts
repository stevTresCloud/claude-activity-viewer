import { DEFAULT_MODEL, type AgentResult, type AgentRunConfig } from './types';

/**
 * Forma mínima del envelope de un `SDKMessage`. El SDK ya tipa cada
 * variante (assistant/user/system/result/…) pero todas comparten
 * `session_id`, y la variante system aporta `subtype` + `model`.
 * Centralizamos el cast acá para no repetir `as { ... }` en cada
 * lectura del loop.
 */
interface SDKEnvelope {
  session_id?: string;
  subtype?: string;
  model?: string;
}

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
    // SessionId del SDK. Lo descubrimos en el envelope de cualquier
    // SDKMessage (assistant/user/system/result lo traen) y emitimos
    // un AgentEvent dedicado la primera vez para que el bridge pueda
    // actualizar el snapshot del agente vivo. Sin esto, el sessionId
    // recién aparecería al cierre y el botón Open no podría abrir
    // el chat del plugin claude-code mientras el agente corre.
    let sessionId: string | undefined;
    // Modelo real reportado por el SDK en el `system.init` message.
    // El runner arranca con el alias del caller ('sonnet' default),
    // pero el SDK puede resolverlo a otro id; queremos mostrar lo
    // que el SDK efectivamente eligió, no lo que pedimos.
    let resolvedModel: string | undefined;

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
          // Respetamos lo que pidió el caller (MCP / palette);
          // default DEFAULT_MODEL. El SDK lo resuelve a su id
          // interno y lo reporta en SDKSystemMessage.init.model —
          // capturado abajo y emitido como AgentEvent('model').
          model: config.model ?? DEFAULT_MODEL,
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

        // === Captura de identidad y modelo del envelope ===
        // Cualquier SDKMessage del envelope trae `session_id`; el
        // primer system.init además trae `model`. Capturamos UNA
        // vez cada uno y emitimos AgentEvent dedicado. Outer guard
        // corta el bloque entero una vez tenemos ambos, así el
        // resto de mensajes del stream (~cientos) no leen
        // propiedades que ya no necesitamos.
        if (!sessionId || !resolvedModel) {
          const envelope = event as SDKEnvelope;
          if (!sessionId && typeof envelope.session_id === 'string' && envelope.session_id.length > 0) {
            sessionId = envelope.session_id;
            config.onEvent({ type: 'session_id', sessionId });
          }
          if (
            !resolvedModel &&
            event.type === 'system' &&
            envelope.subtype === 'init' &&
            typeof envelope.model === 'string' &&
            envelope.model.length > 0
          ) {
            resolvedModel = envelope.model;
            config.onEvent({ type: 'model', name: resolvedModel });
          }
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

            // === Usage incremental ===
            // Cada `assistant` message del SDK trae su propio
            // `message.usage` con input/output/cache tokens del
            // turno actual. Sin este emit el ContextBar quedaba en
            // 0% durante todo el run y solo se actualizaba con el
            // `result` final (que llega cuando el agente termina).
            // Emitimos el usage del turno; el bridge reemplaza
            // (no acumula) — semántica "context activo ahora".
            const msgUsage = event.message.usage;
            if (msgUsage) {
              const incIn = msgUsage.input_tokens ?? 0;
              const incOut = msgUsage.output_tokens ?? 0;
              if (incIn > 0 || incOut > 0) {
                config.onEvent({
                  type: 'usage_turn',
                  inputTokens: incIn,
                  outputTokens: incOut,
                  cacheReadTokens: msgUsage.cache_read_input_tokens ?? 0,
                  cacheCreationTokens: msgUsage.cache_creation_input_tokens ?? 0,
                });
              }
            }

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
            // Acumulados a través de TODOS los turnos del agente — el
            // bridge usa este evento SOLO para fijar el costUsd y los
            // tokens billables finales. Pisar contextTokens con estos
            // valores rompía el ContextBar al cierre (ver
            // V0_1_0_FIELD_REPORT.md: contextTokens reportado en 10.9M).
            config.onEvent({
              type: 'usage_final',
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
      sessionId,
      model: resolvedModel,
    };
  }
}
