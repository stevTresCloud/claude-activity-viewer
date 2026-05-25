import * as vscode from 'vscode';
import type { AgentRunner } from '../runtime/agent-runner';
import { logAgentEvent, ts } from '../runtime/log';

// Prompt fijo del comando "Test Agent". Pensado para ejercer el ciclo
// completo SDK → runner → OutputChannel + dar tiempo a cancelar mid-stream.
// Usa tools (Glob + Read) sobre el cwd sin modificar archivos.
const TEST_PROMPT =
  'Listá los archivos .ts dentro de src/ del directorio actual. ' +
  'Por cada uno, leelo y dame un resumen de 1 línea de qué hace. ' +
  'No edites nada.';

/**
 * Registra los comandos del palette para probar un agente único.
 *
 * Soporta UN test agent a la vez. Múltiples agentes en paralelo entran
 * más adelante cuando el dashboard kanban exista (y demanda compartir el
 * runner con el MCP server, no instanciar uno propio).
 *
 * @param context  contexto de la extensión (para registrar disposables).
 * @param channel  OutputChannel compartido donde se loggean los eventos.
 * @param runner   `AgentRunner` compartido con el resto de la extensión.
 */
export function registerTestAgentCommands(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  runner: AgentRunner,
): void {
  // Estado de la corrida activa (si hay). Cerrar/cancelar este controller
  // dispara el bridge interno del runner que aborta el subprocess SDK.
  let activeAbort: AbortController | null = null;

  const testCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.testAgent',
    async () => {
      // Guard: un solo test a la vez por ahora.
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
          onEvent: (event) => logAgentEvent(channel, event),
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
