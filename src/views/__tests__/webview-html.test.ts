/* ================================================================
 * webview-html.test.ts — Tests del builder compartido de HTML del
 * webview.
 *
 * Cubre las 2 ramas:
 *   1. Sidebar (`inlineConfig` ausente) — sin nonce, sin script
 *      inline, CSP estricta sin `'nonce-...'`.
 *   2. Detail (`inlineConfig` presente) — con nonce + script inline
 *      que setea `window.__claudeActivityViewer`, CSP autoriza el
 *      nonce, `<` escapado para defender contra `</script>` payload.
 *
 * Las dos ramas convergen en el regex de reescritura de assets/ y
 * en la cabecera <meta http-equiv="Content-Security-Policy">. La
 * diferencia es el shape del CSP `script-src` y la presencia del
 * inline script.
 * ================================================================ */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(
    () =>
      '<html><head><title>App</title></head>' +
      '<body>' +
      '<script type="module" crossorigin src="./assets/index.js"></script>' +
      '<link rel="stylesheet" crossorigin href="./assets/index.css">' +
      '</body></html>',
  ),
}));

import { buildWebviewHtml } from '../webview-html';

function makeWebview() {
  return {
    cspSource: 'vscode-webview://test',
    asWebviewUri: vi.fn((uri: { fsPath: string }) => ({
      toString: () => `vscode-webview-uri://${uri.fsPath}`,
    })),
  } as never;
}

const extensionUri = { fsPath: '/ext', toString: () => '/ext' } as never;

describe('buildWebviewHtml · sidebar (sin inlineConfig)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inyecta CSP sin nonce y sin script inline', () => {
    const html = buildWebviewHtml({
      webview: makeWebview(),
      extensionUri,
    });
    expect(html).toContain('Content-Security-Policy');
    // CSP `script-src` debe ser solo cspSource — no `nonce-...`.
    expect(html).toMatch(/script-src vscode-webview:\/\/test;/);
    // Sin <script nonce="..."> inline.
    expect(html).not.toMatch(/<script nonce="/);
    // Sin window.__claudeActivityViewer.
    expect(html).not.toContain('window.__claudeActivityViewer');
  });

  it('reescribe paths ./assets/* a vscode-webview-uri:// del root', () => {
    const html = buildWebviewHtml({
      webview: makeWebview(),
      extensionUri,
    });
    expect(html).toContain('vscode-webview-uri:///ext/out/webview/assets/index.js');
    expect(html).toContain('vscode-webview-uri:///ext/out/webview/assets/index.css');
    expect(html).not.toContain('./assets/');
  });
});

describe('buildWebviewHtml · detail (con inlineConfig)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inyecta nonce + script con window.__claudeActivityViewer', () => {
    const html = buildWebviewHtml({
      webview: makeWebview(),
      extensionUri,
      inlineConfig: { mode: 'detail', agentId: 'agent-abc' },
    });
    expect(html).toMatch(/<script nonce="[A-Za-z0-9+/=]+">/);
    expect(html).toContain(
      'window.__claudeActivityViewer = {"mode":"detail","agentId":"agent-abc"}',
    );
  });

  it('CSP script-src incluye el nonce generado', () => {
    const html = buildWebviewHtml({
      webview: makeWebview(),
      extensionUri,
      inlineConfig: { mode: 'detail', agentId: 'a-1' },
    });
    const nonceMatch = html.match(/<script nonce="([^"]+)">/);
    expect(nonceMatch).not.toBeNull();
    const nonce = nonceMatch![1];
    expect(html).toContain(`'nonce-${nonce}'`);
  });

  it('escapa `<` post-stringify para defender contra payload con </script>', () => {
    // Aunque agentId sea un valor adversario con `</script>`, el
    // helper debe escaparlo como < y no romper el parser HTML.
    const html = buildWebviewHtml({
      webview: makeWebview(),
      extensionUri,
      inlineConfig: { mode: 'detail', agentId: '</script><script>x' },
    });
    expect(html).not.toContain('</script><script>x');
    expect(html).toContain('\\u003c/script>\\u003cscript>x');
  });
});
