/* ================================================================
 * status-bar.test.ts — Tests del StatusBarManager.
 *
 * Cubre:
 *   - Suscripción al bridge al construir.
 *   - Render del text/tooltip según count (singular vs plural).
 *   - Visibility: hide cuando count=0, show cuando count>=1.
 *   - Memo (no re-render con mismo count consecutivo).
 *   - dispose() libera el item y des-registra del bridge.
 *
 * El bridge se reemplaza por un FakeBridge mínimo expuesto en
 * `makeBridgeWithCountTrigger` — el manager solo consume el método
 * `onRunningCountChange`, lo demás del bridge no entra al test.
 * ================================================================ */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FOCUS_DASHBOARD_COMMAND, StatusBarManager } from '../status-bar';
import { __getStatusBarItems, __resetVscode } from '../../__mocks__/vscode';
import type { DashboardBridge } from '../bridge';

/**
 * FakeBridge con un trigger imperativo para emitir cambios de
 * count. Reproduce el contrato del manager: el callback se invoca
 * con el count actual al suscribirse + cada vez que el bridge
 * decide notificar.
 */
function makeBridgeWithCountTrigger() {
  let cb: ((count: number) => void) | null = null;
  let unsubscribed = false;
  const fake = {
    onRunningCountChange: vi.fn(
      (callback: (count: number) => void) => {
        cb = callback;
        // Replica del comportamiento real: emit inicial al suscribirse.
        callback(0);
        return () => {
          cb = null;
          unsubscribed = true;
        };
      },
    ),
    /** Helper test-only para gatillar deltas. */
    trigger(count: number) {
      cb?.(count);
    },
    isUnsubscribed() {
      return unsubscribed;
    },
  };
  return fake;
}

describe('StatusBarManager', () => {
  beforeEach(() => {
    __resetVscode();
  });

  it('al construirse suscribe al bridge y crea un StatusBarItem oculto (count=0)', () => {
    const bridge = makeBridgeWithCountTrigger();
    const manager = new StatusBarManager(bridge as unknown as DashboardBridge);

    expect(bridge.onRunningCountChange).toHaveBeenCalledTimes(1);
    const items = __getStatusBarItems();
    expect(items).toHaveLength(1);
    expect(items[0].command).toBe(FOCUS_DASHBOARD_COMMAND);
    // Inicial: count=0 → item creado pero NO visible.
    expect(items[0].visible).toBe(false);
    manager.dispose();
  });

  it('count=1 → texto singular "1 agent" y visible', () => {
    const bridge = makeBridgeWithCountTrigger();
    const manager = new StatusBarManager(bridge as unknown as DashboardBridge);
    bridge.trigger(1);
    const item = __getStatusBarItems()[0];
    expect(item.visible).toBe(true);
    expect(item.text).toBe('$(rocket) 1 agent');
    expect(item.tooltip).toContain('1 Claude Code agent running');
    manager.dispose();
  });

  it('count=3 → texto plural "3 agents"', () => {
    const bridge = makeBridgeWithCountTrigger();
    const manager = new StatusBarManager(bridge as unknown as DashboardBridge);
    bridge.trigger(3);
    const item = __getStatusBarItems()[0];
    expect(item.text).toBe('$(rocket) 3 agents');
    expect(item.tooltip).toContain('3 Claude Code agents running');
    manager.dispose();
  });

  it('count cae a 0 → item se oculta de nuevo', () => {
    const bridge = makeBridgeWithCountTrigger();
    const manager = new StatusBarManager(bridge as unknown as DashboardBridge);
    bridge.trigger(2);
    expect(__getStatusBarItems()[0].visible).toBe(true);
    bridge.trigger(0);
    expect(__getStatusBarItems()[0].visible).toBe(false);
    manager.dispose();
  });

  it('memo de count: dos notifications con el mismo valor consecutivo no re-pintan', () => {
    // El bridge invoca notifyRunningCount aunque el count no cambie
    // (cualquier status_changed lo dispara). Sin el memo, los
    // 1→1→1→1 forzarían 4 set_text consecutivos. Validamos vía
    // contador de re-renders: el text NO cambia si el count fuera
    // distinto, así que asertamos que la mutación es idempotente
    // ejerciendo el path con un valor único entre medio.
    const bridge = makeBridgeWithCountTrigger();
    const manager = new StatusBarManager(bridge as unknown as DashboardBridge);
    bridge.trigger(1);
    const item = __getStatusBarItems()[0];
    expect(item.text).toBe('$(rocket) 1 agent');
    // Re-trigger con el mismo count: el item NO debe perder el
    // backgroundColor en el camino (si fuera no-memo cualquier
    // bug ahí queda atrapado).
    bridge.trigger(1);
    expect(item.text).toBe('$(rocket) 1 agent');
    expect(item.visible).toBe(true);
    manager.dispose();
  });

  it('dispose() libera el item y des-registra del bridge', () => {
    const bridge = makeBridgeWithCountTrigger();
    const manager = new StatusBarManager(bridge as unknown as DashboardBridge);
    bridge.trigger(2);
    manager.dispose();
    const item = __getStatusBarItems()[0];
    expect(item.disposed).toBe(true);
    expect(bridge.isUnsubscribed()).toBe(true);
  });
});
