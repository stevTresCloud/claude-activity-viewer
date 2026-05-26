/* ================================================================
 * resolveProjectName.ts — Resuelve un projectId al name del proyecto.
 *
 * Extraído del computed inline que vivía en `SingleProjectView.vue`
 * para que sea testeable sin montar el componente. Encapsula la
 * dualidad de fuentes:
 *
 *   - Proyectos del store (derivados de agentes vivos en esta sesión).
 *   - Proyectos descubiertos por el scanner del filesystem (puede
 *     estar en el dropdown sin tener agente en el store).
 *
 * Si el id no aparece en `store.projects`, asumimos convención
 * compartida `p-<name>` (definida tanto en useAgentsStore como en
 * ProjectSelector cuando construye los diskOnlyProjects).
 *
 * Por qué no buscar en scanner store: agregar dependencia a otro
 * store solo para resolver un name dispara reactividad extra cada
 * vez que el scanner emite. El fallback "extraer del id" es O(1)
 * y deterministic.
 * ================================================================ */

const PROJECT_ID_PREFIX = 'p-';

export interface ProjectLike {
  id: string;
  name: string;
}

/**
 * Resuelve el `name` de un proyecto a partir de su id seleccionado.
 *
 *   - Si selectedId es null/empty → null (vista "All projects").
 *   - Si selectedId matchea un proyecto del store → devuelve su name.
 *   - Si no, y selectedId arranca con `p-` → devuelve el sufijo
 *     (caso solo-disco: dropdown muestra el proyecto pero el store
 *     no lo tiene).
 *   - Caso degenerado (id sin prefijo) → null.
 */
export function resolveProjectName(
  selectedId: string | null,
  storeProjects: readonly ProjectLike[],
): string | null {
  if (!selectedId) return null;
  const fromStore = storeProjects.find((p) => p.id === selectedId);
  if (fromStore) return fromStore.name;
  if (selectedId.startsWith(PROJECT_ID_PREFIX)) {
    return selectedId.slice(PROJECT_ID_PREFIX.length);
  }
  return null;
}
