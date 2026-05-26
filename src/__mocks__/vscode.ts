/* ================================================================
 * __mocks__/vscode.ts — Stub manual del namespace `vscode` para tests.
 *
 * El módulo real `vscode` solo existe dentro del extension host. En
 * tests Node puros el import falla. Este archivo aporta la
 * superficie mínima que el código bajo prueba consume:
 *
 *   - `workspace.getConfiguration(section).get(key, default)`
 *   - `workspace.workspaceFolders`
 *
 * El resto de la API VS Code que la extensión usa (OutputChannel,
 * ExtensionContext, Webview, etc.) NO se mockea acá: los tests
 * inyectan fakes directos al constructor del DashboardBridge, que
 * los recibe por DI. Mantener este mock acotado evita simular un
 * ecosistema que no usamos.
 *
 * Helpers `__set...` y `__resetVscode` son test-only: los tests los
 * importan para configurar el estado del workspace simulado antes
 * de cada caso. El runtime real nunca los toca (no existe este
 * archivo en producción).
 * ================================================================ */

import { vi } from 'vitest';

type ConfigStore = Record<string, Record<string, unknown>>;
type FolderEntry = { readonly uri: { readonly fsPath: string } };

// === Estado mutable per-test ===
//
// Se resetea con `__resetVscode()`. Cada test que toque
// configuración o folders debe llamar el reset en beforeEach para
// no heredar state del test anterior.
let configValues: ConfigStore = {};
let workspaceFoldersValue: FolderEntry[] | undefined = undefined;

// La respuesta default es `undefined`, simulando dismiss del modal.
// Los tests que prueban el branch "user confirmó" la pueden setear
// con `__setWarningChoice('Resume')` o equivalente antes del act.
let warningChoice: string | undefined = undefined;
const warningCalls: Array<{
  message: string;
  options: Record<string, unknown>;
  items: string[];
}> = [];

// Espías de showInformationMessage. Lo necesitan los tests del
// handler `request_open` (toast "Session not started yet"), del
// fallback chat→terminal de `resumeSession` y del CompletionNotifier
// (toast "agent finished" con botón "Open detail").
let infoChoice: string | undefined = undefined;
const infoCalls: Array<{ message: string; items: string[] }> = [];

// Comandos ejecutados via vscode.commands.executeCommand. El
// handler `request_open` invoca `vscode.open` con un Uri y los
// tests de status-bar invocan `workbench.view.extension.X` —
// guardamos la cola para asertar el último.
const executedCommands: Array<{ command: string; args: unknown[] }> = [];

// Items creados via createStatusBarItem. La fixture les agrega
// métodos espiables para verificar text/tooltip/show/hide.
const statusBarItems: Array<{
  alignment: number;
  priority: number;
  name: string;
  text: string;
  tooltip: string;
  command: string;
  backgroundColor: unknown;
  visible: boolean;
  disposed: boolean;
}> = [];

// Panels creados via createWebviewPanel. Los tests del
// DetailPanelManager inspeccionan estas instancias para verificar
// open/reveal/dispose y secuenciamiento entre agentes distintos.
interface FakeWebviewPanel {
  viewType: string;
  title: string;
  viewColumn: number;
  options: Record<string, unknown>;
  iconPath: unknown;
  disposed: boolean;
  webview: {
    html: string;
    cspSource: string;
    asWebviewUri: (uri: unknown) => unknown;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
  };
  reveal: ReturnType<typeof vi.fn>;
  dispose: () => void;
  onDidDispose: (cb: () => void) => void;
  _disposeListeners: Array<() => void>;
}
const webviewPanels: FakeWebviewPanel[] = [];

// === API pública (la que ve el código bajo prueba) ===

export const workspace = {
  getConfiguration(section: string) {
    return {
      get<T>(key: string, defaultValue?: T): T {
        const sectionStore = configValues[section];
        if (sectionStore && key in sectionStore) {
          return sectionStore[key] as T;
        }
        return defaultValue as T;
      },
    };
  },
  // Getter para que la lectura sea siempre fresca: si un test
  // setea folders mid-test, el siguiente `vscode.workspace.workspaceFolders`
  // ve el cambio.
  get workspaceFolders(): FolderEntry[] | undefined {
    return workspaceFoldersValue;
  },
};

// === window — solo lo que el código bajo prueba consume ===
//
// `showWarningMessage` lo usa el scanner-controller para los modals
// de confirmación de resume + cancel. Acepta tanto la firma `(msg,
// ...items)` como `(msg, options, ...items)` que VS Code expone;
// internamente normalizamos.

export const window = {
  showWarningMessage(
    message: string,
    optionsOrFirstItem: unknown,
    ...rest: string[]
  ): Promise<string | undefined> {
    let options: Record<string, unknown> = {};
    let items: string[];
    if (typeof optionsOrFirstItem === 'string') {
      items = [optionsOrFirstItem, ...rest];
    } else if (optionsOrFirstItem && typeof optionsOrFirstItem === 'object') {
      options = optionsOrFirstItem as Record<string, unknown>;
      items = rest;
    } else {
      items = rest;
    }
    warningCalls.push({ message, options, items });
    return Promise.resolve(warningChoice);
  },
  showInformationMessage(
    message: string,
    ...items: string[]
  ): Promise<string | undefined> {
    infoCalls.push({ message, items });
    return Promise.resolve(infoChoice);
  },
  showErrorMessage(message: string): Promise<undefined> {
    // No tracked todavía — los tests actuales no asertan errores.
    void message;
    return Promise.resolve(undefined);
  },
  createStatusBarItem(alignment: number, priority: number) {
    const item = {
      alignment,
      priority,
      name: '',
      text: '',
      tooltip: '',
      command: '',
      backgroundColor: undefined as unknown,
      visible: false,
      disposed: false,
      show(): void {
        this.visible = true;
      },
      hide(): void {
        this.visible = false;
      },
      dispose(): void {
        this.disposed = true;
        this.visible = false;
      },
    };
    statusBarItems.push(item);
    return item;
  },
  createTerminal(): never {
    // Si algún test del scanner-controller llega acá (resumeSession
    // en modo terminal fallback), explota — preferimos diagnóstico
    // claro a una llamada silenciosa.
    throw new Error('mocked vscode.window.createTerminal no implementado');
  },
  createWebviewPanel(
    viewType: string,
    title: string,
    viewColumn: number,
    options: Record<string, unknown>,
  ): FakeWebviewPanel {
    const panel: FakeWebviewPanel = {
      viewType,
      title,
      viewColumn,
      options,
      iconPath: undefined,
      disposed: false,
      _disposeListeners: [],
      webview: {
        html: '',
        cspSource: 'self',
        asWebviewUri: (uri: unknown) => uri,
        onDidReceiveMessage: vi.fn(),
        postMessage: vi.fn(),
      },
      reveal: vi.fn(),
      dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const cb of this._disposeListeners) cb();
      },
      onDidDispose(cb: () => void): void {
        this._disposeListeners.push(cb);
      },
    };
    webviewPanels.push(panel);
    return panel;
  },
};

export const commands = {
  executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    executedCommands.push({ command, args });
    return Promise.resolve(undefined);
  },
};

export const StatusBarAlignment = {
  Left: 1,
  Right: 2,
};

export const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
  Three: 3,
};

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export const Uri = {
  parse(value: string) {
    return { toString: () => value, fsPath: value };
  },
  joinPath(base: { fsPath: string }, ...segments: string[]) {
    // Concatenación mínima: une fsPath de base con segments via "/".
    // No normaliza ni resuelve — el test confía en pasarle paths
    // bien formados. Real VS Code usa Uri proper; el mock solo
    // necesita un objeto con `fsPath` para que fs.readFileSync no
    // explote y `toString()` para los regex de buildWebviewHtml.
    const joined = [base.fsPath, ...segments].join('/');
    return { toString: () => joined, fsPath: joined };
  },
};

// Extensions namespace. El handler `request_open` (y resumeSession)
// chequean `vscode.extensions.getExtension('anthropic.claude-code')`
// antes de invocar el URI handler. Default: la extensión está
// instalada (la fixture mínima); los tests que quieran simular
// "no instalada" pueden hacer `vi.mocked(extensions.getExtension).mockReturnValueOnce(undefined)`.
export const extensions = {
  getExtension(_id: string): { id: string } | undefined {
    return { id: _id };
  },
};

// === Helpers test-only ===

export function __setConfig(section: string, key: string, value: unknown): void {
  if (!configValues[section]) configValues[section] = {};
  configValues[section][key] = value;
}

export function __setWorkspaceFolders(paths: string[]): void {
  workspaceFoldersValue = paths.length
    ? paths.map((p) => ({ uri: { fsPath: p } }))
    : undefined;
}

/** Setea qué string devuelve el próximo `showWarningMessage`. */
export function __setWarningChoice(choice: string | undefined): void {
  warningChoice = choice;
}

/** Setea qué string devuelve el próximo `showInformationMessage`. */
export function __setInfoChoice(choice: string | undefined): void {
  infoChoice = choice;
}

/** Lista de llamadas a `showWarningMessage` desde el último reset. */
export function __getWarningCalls(): ReadonlyArray<{
  message: string;
  options: Record<string, unknown>;
  items: string[];
}> {
  return warningCalls;
}

/** Llamadas a `showInformationMessage` desde el último reset. */
export function __getInfoCalls(): ReadonlyArray<{ message: string; items: string[] }> {
  return infoCalls;
}

/** Comandos ejecutados via `commands.executeCommand` desde el último reset. */
export function __getExecutedCommands(): ReadonlyArray<{
  command: string;
  args: unknown[];
}> {
  return executedCommands;
}

/**
 * Status bar items creados via `window.createStatusBarItem`. Los
 * tests del StatusBarManager los inspeccionan para verificar
 * text/tooltip/show/hide.
 */
export function __getStatusBarItems(): ReadonlyArray<{
  text: string;
  tooltip: string;
  command: string;
  visible: boolean;
  disposed: boolean;
}> {
  return statusBarItems;
}

/**
 * Panels creados via `window.createWebviewPanel`. Los tests del
 * DetailPanelManager los inspeccionan para verificar el ciclo
 * create/reveal/dispose ante distintos agentes.
 */
export function __getWebviewPanels(): ReadonlyArray<{
  viewType: string;
  title: string;
  disposed: boolean;
  reveal: ReturnType<typeof vi.fn>;
}> {
  return webviewPanels;
}

export function __resetVscode(): void {
  configValues = {};
  workspaceFoldersValue = undefined;
  warningChoice = undefined;
  warningCalls.length = 0;
  infoChoice = undefined;
  infoCalls.length = 0;
  executedCommands.length = 0;
  statusBarItems.length = 0;
  webviewPanels.length = 0;
}
