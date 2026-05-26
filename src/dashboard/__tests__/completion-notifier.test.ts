/* ================================================================
 * completion-notifier.test.ts — Tests del toast VS Code.
 *
 * Cubre:
 *   - Suscripción al bridge.onAgentCompleted al construir.
 *   - Setting notifyOnComplete=false → no toast.
 *   - Setting notifyOnComplete=true + status done → showInformationMessage.
 *   - Status failed → showWarningMessage (severity ≠).
 *   - Click "Open detail" → invoca el callback con agentId+name.
 *   - Click backdrop / dismiss → no invoca callback.
 *   - Formato del mensaje (helper formatMessage).
 *   - dispose() desuscribe del bridge.
 * ================================================================ */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CompletionNotifier,
  formatMessage,
} from '../completion-notifier';
import {
  __getInfoCalls,
  __getWarningCalls,
  __resetVscode,
  __setConfig,
  __setInfoChoice,
} from '../../__mocks__/vscode';
import { makeOutputChannel } from './_fixtures';
import type {
  AgentCompletionEvent,
  DashboardBridge,
} from '../bridge';

/** Fake bridge mínimo: solo onAgentCompleted con trigger imperativo. */
function makeBridgeWithTrigger() {
  let cb: ((e: AgentCompletionEvent) => void) | null = null;
  let unsubscribed = false;
  return {
    onAgentCompleted: vi.fn((listener: (e: AgentCompletionEvent) => void) => {
      cb = listener;
      return () => {
        cb = null;
        unsubscribed = true;
      };
    }),
    /** Helper test-only para gatillar el listener. */
    trigger(event: AgentCompletionEvent): void {
      cb?.(event);
    },
    isUnsubscribed(): boolean {
      return unsubscribed;
    },
  };
}

function eventBase(overrides: Partial<AgentCompletionEvent> = {}): AgentCompletionEvent {
  return {
    agentId: 'agent-abc',
    name: 'my-agent',
    status: 'done',
    durationMs: 4_321,
    tokensUsed: 1_500,
    ...overrides,
  };
}

beforeEach(() => {
  __resetVscode();
});

describe('CompletionNotifier', () => {
  it('al construirse suscribe al bridge', () => {
    const bridge = makeBridgeWithTrigger();
    const notifier = new CompletionNotifier({
      bridge: bridge as unknown as DashboardBridge,
      channel: makeOutputChannel() as never,
      showDetail: vi.fn(),
    });
    expect(bridge.onAgentCompleted).toHaveBeenCalledTimes(1);
    notifier.dispose();
  });

  it('setting notifyOnComplete=false → NO muestra toast', async () => {
    __setConfig('claudeOrchestrator', 'notifyOnComplete', false);
    const bridge = makeBridgeWithTrigger();
    const showDetail = vi.fn();
    const notifier = new CompletionNotifier({
      bridge: bridge as unknown as DashboardBridge,
      channel: makeOutputChannel() as never,
      showDetail,
    });

    bridge.trigger(eventBase());
    await new Promise((resolve) => setImmediate(resolve));

    expect(__getInfoCalls()).toHaveLength(0);
    expect(__getWarningCalls()).toHaveLength(0);
    expect(showDetail).not.toHaveBeenCalled();
    notifier.dispose();
  });

  it('status=done → showInformationMessage con texto del agente', async () => {
    // setting default es true, no necesitamos setear.
    const bridge = makeBridgeWithTrigger();
    const notifier = new CompletionNotifier({
      bridge: bridge as unknown as DashboardBridge,
      channel: makeOutputChannel() as never,
      showDetail: vi.fn(),
    });

    bridge.trigger(eventBase({ name: 'audit-py', durationMs: 134_000, tokensUsed: 12_500 }));
    await new Promise((resolve) => setImmediate(resolve));

    const calls = __getInfoCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('audit-py');
    expect(calls[0].message).toContain('finished');
    expect(calls[0].message).toContain('2m 14s');
    expect(calls[0].message).toContain('12.5k tokens');
    notifier.dispose();
  });

  it('status=failed → showWarningMessage (severity diferente)', async () => {
    const bridge = makeBridgeWithTrigger();
    const notifier = new CompletionNotifier({
      bridge: bridge as unknown as DashboardBridge,
      channel: makeOutputChannel() as never,
      showDetail: vi.fn(),
    });

    bridge.trigger(eventBase({ status: 'failed', reason: 'connection refused' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(__getWarningCalls()).toHaveLength(1);
    expect(__getInfoCalls()).toHaveLength(0);
    expect(__getWarningCalls()[0].message).toContain('failed');
    expect(__getWarningCalls()[0].message).toContain('connection refused');
    notifier.dispose();
  });

  it('status=cancelled → showInformationMessage (no es error)', async () => {
    const bridge = makeBridgeWithTrigger();
    const notifier = new CompletionNotifier({
      bridge: bridge as unknown as DashboardBridge,
      channel: makeOutputChannel() as never,
      showDetail: vi.fn(),
    });

    bridge.trigger(eventBase({ status: 'cancelled' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(__getInfoCalls()).toHaveLength(1);
    expect(__getWarningCalls()).toHaveLength(0);
    expect(__getInfoCalls()[0].message).toContain('was cancelled');
    notifier.dispose();
  });

  it('click "Open detail" → invoca showDetail con agentId + name', async () => {
    // Status default=done → va por showInformationMessage. El mock
    // devuelve el `infoChoice` seteado acá cuando el código llama
    // showInformationMessage. Sin esto el toast resolvería con
    // undefined (dismiss) y el handler no invocaría showDetail.
    __setInfoChoice('Open detail');
    const bridge = makeBridgeWithTrigger();
    const showDetail = vi.fn();
    const notifier = new CompletionNotifier({
      bridge: bridge as unknown as DashboardBridge,
      channel: makeOutputChannel() as never,
      showDetail,
    });

    bridge.trigger(eventBase({ agentId: 'abc', name: 'my-agent' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(showDetail).toHaveBeenCalledTimes(1);
    expect(showDetail).toHaveBeenCalledWith('abc', 'my-agent');
    notifier.dispose();
  });

  it('dismiss/sin elegir → NO invoca showDetail', async () => {
    // El mock devuelve undefined por default (dismiss).
    const bridge = makeBridgeWithTrigger();
    const showDetail = vi.fn();
    const notifier = new CompletionNotifier({
      bridge: bridge as unknown as DashboardBridge,
      channel: makeOutputChannel() as never,
      showDetail,
    });

    bridge.trigger(eventBase());
    await new Promise((resolve) => setImmediate(resolve));

    expect(showDetail).not.toHaveBeenCalled();
    notifier.dispose();
  });

  it('dispose() desuscribe del bridge', () => {
    const bridge = makeBridgeWithTrigger();
    const notifier = new CompletionNotifier({
      bridge: bridge as unknown as DashboardBridge,
      channel: makeOutputChannel() as never,
      showDetail: vi.fn(),
    });
    notifier.dispose();
    expect(bridge.isUnsubscribed()).toBe(true);
  });
});

describe('formatMessage', () => {
  it('done: "Agent X finished in 2m 14s · 12.5k tokens"', () => {
    expect(
      formatMessage(eventBase({ name: 'X', durationMs: 134_000, tokensUsed: 12_500 })),
    ).toBe('Agent X finished in 2m 14s · 12.5k tokens');
  });

  it('failed con reason: incluye reason truncada al final', () => {
    const msg = formatMessage(
      eventBase({
        name: 'X',
        status: 'failed',
        durationMs: 5_000,
        tokensUsed: 100,
        reason: 'connection refused at host xyz',
      }),
    );
    expect(msg).toContain('Agent X failed in 5s');
    expect(msg).toContain('(connection refused at host xyz)');
  });

  it('cancelled: "was cancelled" en lugar de "finished"', () => {
    expect(
      formatMessage(eventBase({ name: 'X', status: 'cancelled', durationMs: 1_000, tokensUsed: 0 })),
    ).toBe('Agent X was cancelled in 1s');
  });

  it('tokens=0 omite el segmento de tokens', () => {
    const msg = formatMessage(eventBase({ name: 'X', durationMs: 1_000, tokensUsed: 0 }));
    expect(msg).toBe('Agent X finished in 1s');
    expect(msg).not.toContain('tokens');
  });

  it('durationMs < 60s muestra solo segundos', () => {
    expect(formatMessage(eventBase({ name: 'X', durationMs: 4_321, tokensUsed: 0 }))).toBe(
      'Agent X finished in 4s',
    );
  });

  it('reason muy larga se trunca a ~60 chars', () => {
    const longReason = 'x'.repeat(200);
    const msg = formatMessage(
      eventBase({ name: 'X', status: 'failed', reason: longReason, durationMs: 1_000, tokensUsed: 0 }),
    );
    // El mensaje completo no debería contener los 200 chars de la
    // reason — se trunca con elipsis.
    expect(msg.length).toBeLessThan(200);
    expect(msg).toContain('…');
  });
});
