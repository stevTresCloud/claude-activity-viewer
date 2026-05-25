import * as vscode from 'vscode';
import { AgentRunner } from '../runtime/agent-runner';
import type { AgentEvent } from '../runtime/types';

// Prompt fijo del comando "Test Agent". Pensado para ejercer el ciclo
// completo SDK → runner → OutputChannel + dar tiempo a cancelar mid-stream.
// Usa tools (Glob + Read) sobre el cwd sin modificar archivos.
const TEST_PROMPT =
  'Listá los archivos .ts dentro de src/ del directorio actual. ' +
  'Por cada uno, leelo y dame un resumen de 1 línea de qué hace. ' +
  'No edites nada.';

// Truncado defensivo del log para que un tool input/result enorme no
// inunde el OutputChannel. El texto completo del agente sí va sin cortar.
const LOG_TRUNCATE_AT = 200;

/**
 * Registra los comandos del palette para probar un agente único.
 *
 * Fase 1.1: solo soporta UN test agent a la vez. Múltiples agentes en
 * paralelo entran en Fase 1.4 cuando el dashboard kanban exista.
 *
 * @param context  contexto de la extensión (para registrar disposables).
 * @param channel  OutputChannel compartido donde se loggean los eventos.
 */
export function registerTestAgentCommands(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
): void {
  // Runner compartido por ambos comandos: cachea el SDK ya importado y
  // ahorra el costo del dynamic import en arranques sucesivos.
  const runner = new AgentRunner();

  // Estado de la corrida activa (si hay). Cerrar/cancelar este controller
  // dispara el bridge interno del runner que aborta el subprocess SDK.
  let activeAbort: AbortController | null = null;

  const testCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.testAgent',
    async () => {
      // Guard: un solo test a la vez en Fase 1.1.
      if (activeAbort) {
        vscode.window.showWarningMessage(
          'Ya hay un test agent corriendo. Cancelálo antes de lanzar otro.',
        );
        return;
      }

      // cwd: si hay workspace abierto, lo usamos; si no, cwd del proceso.
      // El agente necesita un cwd válido para que Read/Bash/Grep tengan
      // contexto. En EDH suele haber workspace folder al ejecutar comandos.
      const cwd =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

      activeAbort = new AbortController();
      channel.show(true);
      channel.appendLine(
        `[${ts()}] >>> start prompt=${JSON.stringify(TEST_PROMPT)} cwd=${cwd}`,
      );

      try {
        const result = await runner.startAgent({
          prompt: TEST_PROMPT,
          cwd,
          abortSignal: activeAbort.signal,
          onEvent: (event) => logEvent(channel, event),
        });
        channel.appendLine(
          `[${ts()}] <<< done status=${result.status} tools=${result.toolCallCount}` +
            ` duration=${result.durationMs}ms cost=$${result.costUsd.toFixed(4)}`,
        );
      } catch (err) {
        // Defensivo: el runner ya maneja sus errores y retorna AgentResult.
        // Esto solo aplicaría si la importación dinámica falla catastrófica.
        const msg = err instanceof Error ? err.message : String(err);
        channel.appendLine(`[${ts()}] !!! runner error: ${msg}`);
      } finally {
        activeAbort = null;
      }
    },
  );

  const cancelCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.cancelTestAgent',
    () => {
      if (!activeAbort) {
        vscode.window.showInformationMessage(
          'No hay test agent activo para cancelar.',
        );
        return;
      }
      channel.appendLine(`[${ts()}] !!! cancel requested by user`);
      activeAbort.abort();
    },
  );

  context.subscriptions.push(testCmd, cancelCmd);
}

/**
 * Despacha un AgentEvent a una línea legible del OutputChannel.
 * Mantiene una línea por evento para que sea grep-friendly.
 */
function logEvent(channel: vscode.OutputChannel, event: AgentEvent): void {
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
        `[${stamp}] tool_use: ${event.name} input=${truncate(JSON.stringify(event.input), LOG_TRUNCATE_AT)}`,
      );
      break;
    case 'tool_result':
      channel.appendLine(
        `[${stamp}] tool_result: id=${event.toolUseId} error=${event.isError} result=${truncate(event.result, LOG_TRUNCATE_AT)}`,
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

// HH:mm:ss.sss en hora local; usado como prefijo de cada línea del log.
function ts(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
