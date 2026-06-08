/* ================================================================
 * status-bar.ts — Item del status bar de VS Code con el conteo de
 * agentes en estado `running`.
 *
 * Responsabilidades:
 *   1. Crear el `StatusBarItem` al activate y suscribirse al
 *      `onRunningCountChange` del bridge.
 *   2. Refrescar texto + tooltip + visibilidad cada vez que el
 *      count cambia.
 *   3. Disparar el comando `claudeActivityViewer.focusDashboard` al
 *      click para que el usuario salte al sidebar sin pasar por
 *      el palette.
 *
 * Visual (HANDOFF informal, no en spec textual):
 *   - Hidden cuando count === 0. Mostrar "0 agents" no aporta
 *     información y satura el status bar con items inactivos.
 *   - Cuando count >= 1: `$(rocket) N agent` (singular) o
 *     `$(rocket) N agents`. Background prominent para destacar
 *     del resto de items.
 *
 * Tests: el filtro de count + el render son testeables via
 * spy sobre el `StatusBarItem`, ver `__tests__/status-bar.test.ts`.
 * ================================================================ */

import * as vscode from 'vscode';
import type { DashboardBridge } from './bridge';

/** Comando público que invoca el item al click. */
export const FOCUS_DASHBOARD_COMMAND = 'claudeActivityViewer.focusDashboard';

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly unsubscribe: () => void;
  // Memo del último count renderizado. Sin esto, el listener del
  // bridge dispara updates con el mismo valor (notifyRunningCount
  // se invoca en spawn/status/hydrate aunque el count no cambie) y
  // el item haría ::show()/::hide() oscilando.
  private lastCount = -1;

  constructor(bridge: DashboardBridge) {
    // Priority alto para anclar a la izquierda dentro del grupo
    // Right — VS Code ordena Right items de mayor a menor priority
    // (más cerca del borde derecho los más bajos).
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.name = 'Claude Activity Viewer';
    this.item.command = FOCUS_DASHBOARD_COMMAND;
    // El callback emite el count actual al suscribirse — el primer
    // render es coherente con el bridge sin esperar evento.
    this.unsubscribe = bridge.onRunningCountChange((count) =>
      this.update(count),
    );
  }

  private update(count: number): void {
    if (count === this.lastCount) return;
    this.lastCount = count;
    if (count === 0) {
      this.item.hide();
      return;
    }
    const noun = count === 1 ? 'agent' : 'agents';
    this.item.text = `$(rocket) ${count} ${noun}`;
    this.item.tooltip = `${count} Claude Code ${noun} running — click to open Claude Agents dashboard`;
    // Background prominent + foreground default para que destaque
    // del resto del status bar (igual que el badge azul de Source
    // Control con cambios pendientes).
    this.item.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.prominentBackground',
    );
    this.item.show();
  }

  dispose(): void {
    this.unsubscribe();
    this.item.dispose();
  }
}
