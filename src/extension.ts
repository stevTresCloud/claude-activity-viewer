import * as vscode from 'vscode';

/**
 * Punto de entrada de la extensión Claude Orchestrator.
 * Registra los comandos disponibles en la paleta. En esta fase 1.0
 * sólo existe un comando placeholder que valida que el activate se
 * ejecuta y el extension host puede dispararnos comandos.
 */
export function activate(context: vscode.ExtensionContext): void {
  const helloCmd = vscode.commands.registerCommand(
    'claudeOrchestrator.hello',
    () => {
      vscode.window.showInformationMessage(
        'Claude Orchestrator activo. Próxima fase: integrar SDK + AgentRunner.',
      );
    },
  );

  context.subscriptions.push(helloCmd);
}

/**
 * Hook de desactivación. Vacío en fase 1.0; en fases siguientes
 * deberá cerrar agentes activos, drenar logs pendientes y persistir
 * el estado del orquestador.
 */
export function deactivate(): void {
  // No-op en fase 1.0
}
