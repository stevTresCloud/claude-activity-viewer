import * as vscode from 'vscode';
import type { DashboardBridge } from '../dashboard/bridge';
import { ts } from '../runtime/log';

// Prompt fijo del comando "Test Agent". Pensado para ejercer el ciclo
// completo SDK → bridge → webview + dar tiempo a cancelar mid-stream.
// Usa tools (Glob + Read) sobre el cwd sin modificar archivos.
const TEST_PROMPT =
  'Listá los archivos .ts dentro de src/ del directorio actual. ' +
  'Por cada uno, leelo y dame un resumen de 1 línea de qué hace. ' +
  'No edites nada.';

/**
 * Registra los comandos del palette para lanzar/cancelar un agente
 * de prueba. Sirve para validar el flujo end-to-end sin necesidad
 * de un chat externo Claude Code; útil en EDH para iterar
 * cambios al bridge y al webview.
 *
 * El comando `testAgent` lanza vía `bridge.spawn` — exactamente el
 * mismo path que usa el handler MCP. Eso garantiza que lo que
 * vemos en el dashboard refleja lo que un chat externo vería.
 *
 * El guard "uno a la vez" de versiones anteriores desaparece: el
 * bridge soporta N agentes concurrentes. Mantenemos un set de
 * agentIds activos lanzados por el palette para que el comando
 * cancel sepa a quién matar (el del último spawn).
 *
 * @param context  contexto de la extensión (para registrar disposables).
 * @param channel  OutputChannel compartido donde se loggean los eventos.
 * @param bridge   bridge compartido — fuente de verdad del registry.
 */
export function registerTestAgentCommands(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  bridge: DashboardBridge,
): void {
  // Pila de agentIds lanzados por la paleta. El cancel apunta al más
  // reciente — comportamiento intuitivo cuando uno está iterando F5.
  const palette: string[] = [];

  const testCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.testAgent',
    () => {
      // cwd: si hay workspace abierto, lo usamos; si no, cwd del proceso.
      // El agente necesita un cwd válido para que Read/Bash/Grep tengan
      // contexto. En EDH suele haber workspace folder al ejecutar comandos.
      const cwd =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

      channel.show(true);
      channel.appendLine(
        `[${ts()}] >>> palette test agent cwd=${cwd}`,
      );

      const { agentId, finished } = bridge.spawn({
        name: 'palette-test',
        prompt: TEST_PROMPT,
        cwd,
      });
      palette.push(agentId);

      // Log "completado" cuando termina. `finally` (no `then`)
      // garantiza el cleanup del `palette` aunque la promise
      // rechace; sin esto, un error catastrófico del runner
      // dejaría el agentId huérfano en la pila y `cancel`
      // apuntaría a un agente que ya no existe.
      finished.finally(() => {
        const idx = palette.indexOf(agentId);
        if (idx >= 0) palette.splice(idx, 1);
        channel.appendLine(`[${ts()}] <<< palette test agent finished id=${agentId}`);
      });
    },
  );

  const cancelCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.cancelTestAgent',
    () => {
      const last = palette[palette.length - 1];
      if (!last) {
        vscode.window.showInformationMessage(
          'No hay test agent activo para cancelar.',
        );
        return;
      }
      channel.appendLine(`[${ts()}] !!! cancel requested by user id=${last}`);
      bridge.cancel(last);
    },
  );

  context.subscriptions.push(testCmd, cancelCmd);
}
