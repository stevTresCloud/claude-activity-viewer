import * as vscode from 'vscode';
import type { DashboardBridge } from '../dashboard/bridge';
import { ts } from '../runtime/log';
import { MODEL_ALIASES, type ModelAlias } from '../runtime/types';
import { capitalize } from '../shared/format';

// Prompt fijo del comando "Test Agent". Pensado para ejercer el ciclo
// completo SDK → bridge → webview + dar tiempo a cancelar mid-stream.
// Usa tools (Glob + Read) sobre el cwd sin modificar archivos.
// Es agnóstico al workspace para que sirva en cualquier proyecto:
// detecta los primeros archivos significativos sin asumir layout.
const TEST_PROMPT =
  'Listá los primeros 5 archivos relevantes (código fuente, README, ' +
  'config) del directorio actual con Glob o LS. Por cada uno, leelo ' +
  'con Read y dame un resumen breve de 1 línea de qué hace. No ' +
  'edites nada. Respondé en español.';

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
    async () => {
      // cwd: si hay workspace abierto, lo usamos; si no, cwd del proceso.
      // El agente necesita un cwd válido para que Read/Bash/Grep tengan
      // contexto. En EDH suele haber workspace folder al ejecutar comandos.
      const cwd =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

      // === QuickPick del modelo ===
      // El user elige entre los alias soportados. La primera opción
      // 'Use default' respeta el setting `claudeOrchestrator.defaultModel`
      // (más cómodo si el user lo configuró). Dismiss del QuickPick
      // cancela el spawn.
      const model = await pickModel();
      if (model === undefined) {
        channel.appendLine(`[${ts()}] >>> palette test agent cancelled (model picker dismissed)`);
        return;
      }

      channel.show(true);
      channel.appendLine(
        `[${ts()}] >>> palette test agent cwd=${cwd} model=${model ?? 'default'}`,
      );

      const { agentId, finished } = bridge.spawn({
        name: 'palette-test',
        prompt: TEST_PROMPT,
        cwd,
        // `null` significa "usar default del setting"; el bridge ya
        // hace el fallback. Pasamos undefined explícito a la spawn
        // input.
        model: model ?? undefined,
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

/**
 * Muestra un QuickPick con los modelos disponibles + 'Use default'.
 * Retorna:
 *   - `null`  → el user eligió "Use default" → bridge usará el setting.
 *   - alias   → el user eligió un modelo explícito.
 *   - `undefined` → el user dismissó el picker (Esc / click fuera) →
 *                   cancelamos el spawn entero.
 *
 * Exportada implícitamente vía closure del commando; vive en este
 * archivo porque solo el palette `Test Agent` la usa hoy. Si el
 * detail panel o el sidebar agregaran un "spawn from UI" botón,
 * vale la pena moverla a un módulo compartido.
 */
async function pickModel(): Promise<ModelAlias | null | undefined> {
  type Item = vscode.QuickPickItem & { value: ModelAlias | null };
  const items: Item[] = [
    {
      label: 'Use default',
      description: 'Respeta claudeOrchestrator.defaultModel',
      value: null,
    },
    ...MODEL_ALIASES.map((m): Item => ({
      label: capitalize(m),
      description: descriptionFor(m),
      value: m,
    })),
  ];
  const chosen = await vscode.window.showQuickPick(items, {
    title: 'Spawn test agent with model',
    placeHolder: 'Pick a model alias or use the default from settings',
    ignoreFocusOut: false,
  });
  if (!chosen) return undefined;
  return chosen.value;
}

function descriptionFor(alias: ModelAlias): string {
  switch (alias) {
    case 'opus':
      return 'Highest capability, slowest, most expensive';
    case 'sonnet':
      return 'Balanced cost / capability';
    case 'haiku':
      return 'Fastest, cheapest, lowest capability';
  }
}
