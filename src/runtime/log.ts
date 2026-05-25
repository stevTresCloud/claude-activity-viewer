import type * as vscode from 'vscode';
import type { AgentEvent } from './types';

// Truncado defensivo del log para que un tool input/result enorme no
// inunde el OutputChannel. El finalResponse del agente sí va completo
// al CallToolResult; este límite solo afecta a las líneas del canal.
export const LOG_TRUNCATE_AT = 200;

/**
 * HH:mm:ss.sss en hora local. Usado como prefijo de cada línea del log
 * para que sea grep-friendly y se pueda correlacionar con otros logs
 * del sistema (Output channel + claude --debug + journalctl).
 */
export function ts(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export function truncate(s: string, max: number = LOG_TRUNCATE_AT): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Despacha un AgentEvent a una línea legible del OutputChannel.
 *
 * Una línea por evento, formato uniforme entre todos los consumidores
 * del runner (palette commands + MCP tool handlers). Mover el formato
 * acá garantiza que cambiarlo (ej. agregar request-id) sea una sola
 * edición en lugar de N call sites desincronizándose silenciosamente.
 */
export function logAgentEvent(
  channel: vscode.OutputChannel,
  event: AgentEvent,
): void {
  const stamp = ts();
  switch (event.type) {
    case 'thinking':
      channel.appendLine(`[${stamp}] thinking: ${event.text}`);
      break;
    case 'text':
      channel.appendLine(`[${stamp}] text: ${event.text}`);
      break;
    case 'tool_use':
      channel.appendLine(
        `[${stamp}] tool_use: ${event.name} input=${truncate(JSON.stringify(event.input))}`,
      );
      break;
    case 'tool_result':
      channel.appendLine(
        `[${stamp}] tool_result: id=${event.toolUseId} error=${event.isError} result=${truncate(event.result)}`,
      );
      break;
    case 'usage':
      channel.appendLine(
        `[${stamp}] usage: in=${event.inputTokens} out=${event.outputTokens}` +
          ` cacheR=${event.cacheReadTokens} cacheC=${event.cacheCreationTokens}` +
          ` cost=$${event.costUsd.toFixed(4)}`,
      );
      break;
    case 'status':
      channel.appendLine(`[${stamp}] status=${event.status}`);
      break;
  }
}
