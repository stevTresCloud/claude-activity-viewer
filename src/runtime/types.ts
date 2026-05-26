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
  | {
      type: 'usage';
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
