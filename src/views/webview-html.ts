/* ================================================================
 * webview-html.ts — Builder compartido del HTML del webview.
 *
 * Antes vivía duplicado en `dashboard.ts` (sidebar) y
 * `detail-panel.ts` (editor tab): ambos leían el `out/webview/index.html`
 * que emite Vite, reescribían los paths `./assets/...` a URIs
 * `vscode-webview://` y armaban una Content-Security-Policy
 * estricta. La única diferencia era que el detail panel necesitaba
 * inyectar un `<script nonce>` con `window.__claudeOrchestrator`
 * para que el bundle Vue arrancara en modo detail.
 *
 * Centralizar evita drift cuando se actualiza la CSP o el patrón
 * de assets en Vite (ej. si activamos `base: '/'` se vuelven
 * absolutos y el regex hay que ajustarlo en UN lugar, no dos).
 *
 * El helper NO toca el bridge ni el filesystem que no sea el del
 * bundle propio: para usarlo solo hace falta el webview + el
 * extensionUri.
 * ================================================================ */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';

/**
 * Shape estricto del payload inyectado como `window.__claudeOrchestrator`.
 * El consumer Vue (`useDetailMode`) lo lee desde window; mantenemos el
 * shape sincronizado del lado productor para que un typo en `mode` o
 * `agentId` no compile silent en `detail-panel.ts`.
 */
export interface WebviewBootConfig {
  mode: 'sidebar' | 'detail';
  agentId?: string | null;
}

export interface BuildWebviewHtmlOptions {
  /**
   * El webview destinatario. Usamos su `asWebviewUri` para resolver
   * los paths del bundle y su `cspSource` para la CSP.
   */
  webview: vscode.Webview;
  /**
   * Raíz de la extensión instalada. El bundle vive en
   * `<extensionUri>/out/webview/`.
   */
  extensionUri: vscode.Uri;
  /**
   * Si se provee, se inyecta un `<script nonce>` antes del bundle
   * que setea `window.__claudeOrchestrator = inlineConfig`. La CSP
   * se ajusta automáticamente para autorizar el nonce. Pensado
   * para distinguir modo sidebar vs detail.
   */
  inlineConfig?: WebviewBootConfig;
}

/**
 * Construye el HTML del webview reescribiendo paths del bundle Vite
 * + inyectando una CSP estricta. Opcionalmente inyecta un script
 * inline con config (modo, agentId, etc.).
 */
export function buildWebviewHtml(opts: BuildWebviewHtmlOptions): string {
  const { webview, extensionUri, inlineConfig } = opts;
  const webviewRoot = vscode.Uri.joinPath(extensionUri, 'out', 'webview');
  const indexPath = vscode.Uri.joinPath(webviewRoot, 'index.html');
  let html = fs.readFileSync(indexPath.fsPath, 'utf8');

  // Regex captura `src="./assets/..."`, `href="./assets/..."`,
  // `src="assets/..."` y `href="assets/..."` (Vite puede emitir
  // ambas formas dependiendo del config `base`).
  html = html.replace(
    /(href|src)="\.?\/?(assets\/[^"]+)"/g,
    (_match, attr: string, file: string) => {
      const fileUri = webview.asWebviewUri(
        vscode.Uri.joinPath(webviewRoot, file),
      );
      return `${attr}="${fileUri}"`;
    },
  );

  // CSP base + extensión con nonce si hay inlineConfig. El nonce
  // solo se autoriza cuando es necesario — sin inlineConfig la CSP
  // queda más restrictiva.
  const nonce = inlineConfig ? crypto.randomBytes(16).toString('base64') : null;
  const scriptSrc = nonce
    ? `${webview.cspSource} 'nonce-${nonce}'`
    : webview.cspSource;
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `script-src ${scriptSrc}`,
    // style-src permite 'unsafe-inline' porque Vue inyecta <style>
    // dinámicos para SFC scoped styles y Tailwind v4 emite vars
    // inline. Sin esto el render se rompe.
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  // Escape de `<` post-stringify para defender contra que un valor
  // inyectado contenga la secuencia `</script>` y rompa el parser
  // del browser. Hoy todos los valores son UUIDs/enums controlados,
  // pero el helper es para reuso futuro: endurecer es barato.
  const inlineScript = nonce
    ? `\n    <script nonce="${nonce}">window.__claudeOrchestrator = ${JSON.stringify(inlineConfig).replace(/</g, '\\u003c')};</script>`
    : '';

  // Orden importante: CSP primero (para que el script inline ya
  // esté bajo la policy), después el inline script con el nonce,
  // después el bundle de Vite (su <script src="..."> ya viene en
  // el HTML original).
  html = html.replace(
    '<head>',
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">${inlineScript}`,
  );
  return html;
}
