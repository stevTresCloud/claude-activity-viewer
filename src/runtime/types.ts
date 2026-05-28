/**
 * Alias cortos del modelo que aceptamos en el MCP y propagamos al
 * SDK. El SDK puede resolverlos a un id largo (`claude-sonnet-4-5-XXX`)
 * según la cuenta del user — eso se captura en runtime y se muestra
 * con la versión real. La lista es la SSoT del enum del MCP y de
 * los defaults del runner/bridge.
 */
export const MODEL_ALIASES = ['sonnet', 'opus', 'haiku'] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

/** Modelo default cuando el caller no especifica. */
export const DEFAULT_MODEL: ModelAlias = 'sonnet';

export interface AgentRunConfig {
  prompt: string;
  cwd: string;
  /** Alias del SDK; default DEFAULT_MODEL si no viene. */
  model?: ModelAlias;
  abortSignal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  /**
   * Override del toolset que el SDK habilita. Default: preset
   * `claude_code` (todos los tools del CLI). Cuando se pasa un array
   * explícito, el SDK opera en allow-list: solo esos nombres de tool
   * se exponen al agente.
   *
   * Caso de uso primario: el critic Haiku del Mecanismo A (verification).
   * Lo invocamos con `tools: ['Read', 'Bash', 'Grep', 'Glob']` para que
   * NO pueda usar Write/Edit/NotebookEdit y por tanto no pueda modificar
   * el código que está revisando.
   */
  tools?: string[];
}

export type AgentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type AgentEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | {
      type: 'tool_result';
      toolUseId: string;
      result: string;
      isError: boolean;
    }
  /**
   * Usage incremental por TURN (un `assistant` message del SDK). Los
   * campos `inputTokens` / `cacheReadTokens` / `cacheCreationTokens`
   * son los del turno actual — esto representa "cuánto del context
   * window está cargado AHORA mismo". El bridge lo usa para mover
   * `contextTokens` y `contextUsedPct` en vivo.
   *
   * NO trae `costUsd`: el SDK solo expone `total_cost_usd` en el
   * `result` final, no por turno. El costo en vivo se rellena en el
   * próximo `usage_final` cuando el agente termine.
   */
  | {
      type: 'usage_turn';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  /**
   * Usage acumulado al cierre del agente (SDK `result` message). Los
   * campos token son CUMULATIVOS a través de todos los turnos — un
   * agente con 30 turnos puede reportar `cacheReadTokens` de 10M+
   * porque cada turno cache-read ~360k.
   *
   * El bridge usa este evento SOLO para fijar `costUsd` y el
   * `tokensUsed` final billable. NO toca `contextTokens` ni
   * `contextUsedPct` — esos quedan con el último valor de
   * `usage_turn` (= contexto del último turno = lo que se mostraba
   * en vivo). Si pisáramos con los cumulativos acá, la barra
   * mostraría >> 200k (bug histórico del field report).
   */
  | {
      type: 'usage_final';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      costUsd: number;
    }
  | { type: 'status'; status: AgentStatus }
  /**
   * Identidad de la sesión del SDK. Lo emitimos UNA vez por agente,
   * la primera vez que el envelope de SDKMessage trae el `session_id`
   * (típicamente en el primer assistant/system message tras
   * arrancar). Permite al bridge guardarlo en el snapshot para que
   * el botón "Open" (URI handler claude-code) tenga el `?session=`
   * antes de que el agente termine.
   */
  | { type: 'session_id'; sessionId: string }
  /**
   * Modelo REAL que el SDK reportó vía SDKSystemMessage init. El
   * runner inicia con el alias del config (`'sonnet'|'opus'|'haiku'`)
   * pero el SDK puede resolverlo a un id distinto según la cuenta
   * del usuario / la versión activa. Este evento lleva el string
   * crudo del SDK (ej. `'claude-sonnet-4-5-20251022'` o el alias
   * corto si el user pasó alias). El bridge formatea para la UI.
   */
  | { type: 'model'; name: string };

export interface AgentResult {
  status: Exclude<AgentStatus, 'running'>;
  finalResponse: string | null;
  toolCallCount: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** SessionId del SDK; presente cuando el primer message del run lo trajo. */
  sessionId?: string;
  /** Modelo reportado por el SDK (init message). String crudo. */
  model?: string;
}
