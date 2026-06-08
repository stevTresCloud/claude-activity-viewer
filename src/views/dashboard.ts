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
 *   5. Conectamos el webview al `DashboardBridge` para que reciba
 *      eventos del backend (agent_created / status_changed / etc.).
 *
 * Sin más lógica acá. La traducción runtime → wire la hace el bridge;
 * el render lo hace el bundle Vue del webview.
 */

import * as vscode from 'vscode';
import type { DashboardBridge } from '../dashboard/bridge';
import type { DashboardEventToExtension } from '../shared/dashboard-protocol';
import { buildWebviewHtml } from './webview-html';

export class DashboardViewProvider implements vscode.WebviewViewProvider {
  /**
   * id que debe matchear `contributes.views.claudeActivityViewer[].id`
   * del package.json. Es el handle que VS Code usa para mapear la
   * declaración estática a esta instancia.
   */
  public static readonly viewType = 'claudeActivityViewer.dashboard';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: DashboardBridge,
    /**
     * Callback que recibe mensajes del webview (button Resume, botón
     * Rescan, etc.). Lo configura extension.ts y delega al scanner
     * controller / handlers correspondientes. Sin esto el provider
     * no podría reaccionar al click de Resume.
     */
    private readonly onWebviewMessage?: (
      msg: DashboardEventToExtension,
    ) => void,
  ) {}

  /**
   * Hook que dispara VS Code la primera vez que el usuario abre el
   * sidebar de Claude Activity Viewer. Si `retainContextWhenHidden=true`
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
    webview.html = buildWebviewHtml({
      webview,
      extensionUri: this.extensionUri,
      inlineConfig: { mode: 'sidebar' },
    });

    // === Wiring con el bridge ===
    // attachWebview dispara el agent_list inicial (hidratación). El
    // listener onDidDispose desengancha cuando VS Code cierra el view
    // (cambio de sidebar o cierre del IDE) — así el bridge no
    // mantiene una referencia muerta.
    //
    // Le pasamos al detach el token (el propio webview) para que
    // el bridge solo limpie si todavía apunta a ESTE. VS Code puede
    // re-invocar resolveWebviewView (drag entre sidebars) y dejar
    // el listener viejo activo; sin el token, el dispose viejo
    // detacharía un attach posterior, dejando el bridge mudo.
    const token = this.bridge.attachWebview(webview);

    // Webview → Extension: enchufamos el callback configurado por
    // la extensión. Hoy maneja `request_resume_session` y
    // `request_rescan`. Filtro de shape: ignoramos lo que no traiga
    // un `type` string (defensivo contra mensajes ruido).
    if (this.onWebviewMessage) {
      webview.onDidReceiveMessage((raw: unknown) => {
        if (!raw || typeof raw !== 'object') return;
        const candidate = raw as { type?: unknown };
        if (typeof candidate.type !== 'string') return;
        this.onWebviewMessage!(raw as DashboardEventToExtension);
      });
    }

    webviewView.onDidDispose(() => {
      this.bridge.detachWebview(token);
    });
  }
}
