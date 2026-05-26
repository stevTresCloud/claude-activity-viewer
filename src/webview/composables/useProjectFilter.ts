/* ================================================================
 * useProjectFilter.ts — Estado del filtro de proyecto del dashboard.
 *
 * El dashboard tiene dos modos de vista:
 *   - All projects (default): muestra todos los agentes agrupados
 *     por project group.
 *   - Single project: filtra a un solo proyecto, oculta los project
 *     group containers, expande RECENT por default.
 *
 * Este composable es la fuente de verdad del estado actual: si hay
 * un projectId seleccionado, estamos en Single project; si es null,
 * en All projects.
 *
 * ── Por qué composable singleton y NO Pinia store ──
 *
 * Pinia se usa para "estado del dominio" (agentes y proyectos que
 * vienen del backend, que múltiples vistas mutan, donde queremos
 * devtools time-travel). Acá el filter es estado UI-only de
 * navegación: cambia rápido, no se persiste, nadie lo muta desde
 * fuera de la UI.
 *
 * El patrón "ref a nivel del módulo" lo evalúa el bundler una sola
 * vez por proceso, así que cualquier componente que importe
 * `useProjectFilter()` obtiene el MISMO ref reactivo. Es el patrón
 * idiomático Vue 3 para shared UI state sin librería externa.
 *
 * Si más adelante el filter necesita persistir entre reloads
 * (globalState) o reaccionar a eventos del backend, se sube a
 * Pinia. Hoy no lo necesita.
 * ================================================================ */

import { readonly, ref } from 'vue';

// === Estado del módulo (singleton) ===
//
// Declarado fuera de la función `useProjectFilter` para que sea
// compartido por todos los call sites — eso es lo que lo hace
// singleton. Si lo declarara adentro, cada llamada crearía un ref
// nuevo y se rompería la sincronización entre componentes.

const selectedProjectId = ref<string | null>(null);

/**
 * useProjectFilter — accessor del filter compartido.
 *
 * Devuelve el ref en modo readonly para que los componentes no
 * puedan asignarle directamente (`filter.selectedProjectId.value =
 * 'p-001'` no compila). En su lugar, usan las acciones explícitas
 * `selectProject` / `clearFilter` — patrón "1 path de mutación"
 * que facilita razonar sobre los cambios de estado.
 */
export function useProjectFilter() {
  return {
    selectedProjectId: readonly(selectedProjectId),
    selectProject,
    clearFilter,
  };
}

// === Acciones ===

/** Selecciona un proyecto por id. `null` equivale a clearFilter. */
function selectProject(projectId: string | null): void {
  selectedProjectId.value = projectId;
}

/** Vuelve a la vista All projects. */
function clearFilter(): void {
  selectedProjectId.value = null;
}
