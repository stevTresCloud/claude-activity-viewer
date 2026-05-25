export interface AgentRunConfig {
  prompt: string;
  cwd: string;
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
  | { type: 'status'; status: AgentStatus };

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
}
