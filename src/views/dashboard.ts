/**
 * DashboardViewProvider — provee la WebviewView del Activity Bar.
 *
 * VS Code instancia un sandbox <iframe> por cada WebviewView declarado
 * en `contributes.views`. Acá:
 *   1. Le damos permisos mínimos (scripts + localResourceRoots).
 *   2. Cargamos el HTML compilado por Vite (out/webview/index.html).
 *   3. Reescribimos los paths "./assets/..." a URIs `vscode-webview://`
 *      con webview.asWebviewUri() — el navegador del sandbox no puede
 *      cargar archivos del disco directo, necesita URIs proxy.
 *   4. Inyectamos un Content-Security-Policy estricto.
 *
 * Este provider es el cascarón. La lógica de UI (componentes,
 * postMessage, store) entra en sub-fases siguientes.
 */

import * as fs from 'node:fs';
import * as vscode from 'vscode';

export class DashboardViewProvider implements vscode.WebviewViewProvider {
  /**
   * id que debe matchear `contributes.views.claudeOrchestrator[].id`
   * del package.json. Es el handle que VS Code usa para mapear la
   * declaración estática a esta instancia.
   */
  public static readonly viewType = 'claudeOrchestrator.dashboard';

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * Hook que dispara VS Code la primera vez que el usuario abre el
   * sidebar de Claude Orchestrator. Si `retainContextWhenHidden=true`
   * (configurado en el register), esta función corre solo una vez por
   * sesión del IDE.
   */
  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webview = webviewView.webview;

    // === Permisos del sandbox ===
    // enableScripts es obligatorio para que el bundle Vue ejecute.
    // localResourceRoots restringe qué carpetas del extension dir puede
    // leer el webview: limitamos a out/webview/ para no exponer
    // node_modules ni el source TS de la extensión.
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, 'out', 'webview');
    webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
    };

    // === Carga del HTML compilado ===
    // Vite emite out/webview/index.html con paths relativos
    // "./assets/index.js" y "./assets/index.css". Los reescribimos a
    // URIs vscode-webview:// usando asWebviewUri() para que el iframe
    // los pueda fetchear.
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

    // === Content-Security-Policy ===
    // default-src 'none' bloquea TODO lo no permitido explícito —
    // postura segura por defecto.
    // style-src incluye 'unsafe-inline' porque Vue inyecta <style>
    // dinámicos para SFC scoped styles, y Tailwind v4 emite vars
    // inline. Sin esto, el render se rompe.
    // font-src cspSource permite cargar el woff2 de codicons servido
    // desde out/webview/assets/.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `script-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    html = html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
    );

    webview.html = html;
  }
}
