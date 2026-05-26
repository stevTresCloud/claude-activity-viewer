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

type ConfigStore = Record<string, Record<string, unknown>>;
type FolderEntry = { readonly uri: { readonly fsPath: string } };

// === Estado mutable per-test ===
//
// Se resetea con `__resetVscode()`. Cada test que toque
// configuración o folders debe llamar el reset en beforeEach para
// no heredar state del test anterior.
let configValues: ConfigStore = {};
let workspaceFoldersValue: FolderEntry[] | undefined = undefined;

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

export function __resetVscode(): void {
  configValues = {};
  workspaceFoldersValue = undefined;
}
