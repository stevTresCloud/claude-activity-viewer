import * as vscode from 'vscode';
import { registerTestAgentCommands } from './commands/test-agent';

/**
 * Punto de entrada de la extensión Claude Orchestrator.
 *
 * `activate` se dispara cuando VS Code resuelve cualquier
 * `activationEvent` declarado en el package.json (o cuando el usuario
 * invoca un comando contribuido). Registra los comandos y crea el
 * OutputChannel compartido que se reusa entre comandos.
 */
export function activate(context: vscode.ExtensionContext): void {
  // OutputChannel compartido para todo el extension host. Vive en
  // context.subscriptions para que VS Code lo libere al desactivar.
  const channel = vscode.window.createOutputChannel('Claude Orchestrator');
  context.subscriptions.push(channel);

  // Comando smoke histórico: confirma que el extension host nos puede
  // disparar comandos. Útil para validar el setup desde EDH sin tocar
  // la integración con el SDK.
  const helloCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.hello',
    () => {
      vscode.window.showInformationMessage('Claude Orchestrator activo.');
    },
  );
  context.subscriptions.push(helloCmd);

  // Comandos del runner: lanzar y cancelar un agente de prueba.
  registerTestAgentCommands(context, channel);
}

/**
 * Hook de desactivación. No-op intencional: todos los recursos vivos
 * (channel, commands, listeners) están en `context.subscriptions` y los
 * dispose VS Code automáticamente al desactivar la extensión.
 */
export function deactivate(): void {}
