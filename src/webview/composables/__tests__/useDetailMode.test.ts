// @vitest-environment happy-dom

/* ================================================================
 * useDetailMode.test.ts — Tests del composable que lee la config
 * inyectada por el DetailPanelManager en `window.__claudeActivityViewer`.
 *
 * Cubre los 4 caminos del shape:
 *   1. Sin inyección → sidebar default.
 *   2. mode='detail' con agentId → detail con agentId.
 *   3. mode='detail' sin agentId → detail con null (defensivo).
 *   4. mode inválido → sidebar (fallback estricto).
 * ================================================================ */

import { afterEach, describe, expect, it } from 'vitest';

import { useDetailMode } from '../useDetailMode';

declare global {
  interface Window {
    __claudeActivityViewer?: { mode?: string; agentId?: string | null };
  }
}

afterEach(() => {
  // Reset entre tests — el global vive más allá del test si no se
  // limpia (happy-dom mantiene window entre describes).
  delete window.__claudeActivityViewer;
});

describe('useDetailMode', () => {
  it('sin inyección → mode=sidebar, agentId=null', () => {
    const cfg = useDetailMode();
    expect(cfg.mode).toBe('sidebar');
    expect(cfg.agentId).toBeNull();
  });

  it('mode=detail con agentId string → mode=detail, agentId=ese', () => {
    window.__claudeActivityViewer = { mode: 'detail', agentId: 'abc-123' };
    const cfg = useDetailMode();
    expect(cfg.mode).toBe('detail');
    expect(cfg.agentId).toBe('abc-123');
  });

  it('mode=detail sin agentId → mode=detail, agentId=null (defensivo)', () => {
    // Caso bug del extension host: setea mode pero olvida agentId.
    // El composable degrada con null en lugar de undefined; el
    // AgentDetailView renderea el empty-state "Agent not found".
    window.__claudeActivityViewer = { mode: 'detail' };
    const cfg = useDetailMode();
    expect(cfg.mode).toBe('detail');
    expect(cfg.agentId).toBeNull();
  });

  it('mode desconocido → fallback a sidebar', () => {
    // Forward-compat: un modo futuro que el bundle viejo no conoce
    // cae a sidebar (sin crashear). El App.vue rendereará el dashboard.
    window.__claudeActivityViewer = {
      mode: 'something-new',
      agentId: 'x',
    };
    const cfg = useDetailMode();
    expect(cfg.mode).toBe('sidebar');
    expect(cfg.agentId).toBeNull();
  });

  it('agentId no-string en modo detail se descarta (defensivo)', () => {
    // Inyección malformada: agentId numérico/objeto.
    window.__claudeActivityViewer = {
      mode: 'detail',
      agentId: 123 as unknown as string,
    };
    const cfg = useDetailMode();
    expect(cfg.mode).toBe('detail');
    expect(cfg.agentId).toBeNull();
  });
});
