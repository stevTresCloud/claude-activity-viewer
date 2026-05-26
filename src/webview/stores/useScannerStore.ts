/* ================================================================
 * useScannerStore.ts — Estado de proyectos + sesiones desde disco.
 *
 * Store separado de `useAgentsStore` por dos razones:
 *
 *   1. Origen distinto: este store consume eventos
 *      `projects_from_disk` y `sessions_from_disk` del bridge, que
 *      son async-batch (no streaming). El store de agentes consume
 *      eventos en tiempo real. Mezclarlos diluye los responsability
 *      boundaries.
 *
 *   2. Lifecycle distinto: este se hidrata a demanda (scan inicial
 *      o `request_rescan`); el de agentes empieza vacío y crece
 *      con cada spawn.
 *
 * Dedup live↔históricas:
 *   Una sesión histórica con `entrypoint=sdk-ts` y mismo sessionId
 *   que un agente vivo es la MISMA cosa — no se duplica en PAST
 *   SESSIONS. Las sesiones `entrypoint=claude-vscode` SIEMPRE
 *   aparecen aunque coincida sessionId (son chats abiertos por el
 *   user, no por el orchestrator).
 *
 * Referencia: ARCHITECTURE_PHASE_I.md (scanner cross-proyecto).
 * ================================================================ */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  ProjectFromDisk,
  SessionFromDisk,
} from '../../shared/dashboard-protocol';

export const useScannerStore = defineStore('scanner', () => {
  // === State ===

  /**
   * Proyectos descubiertos por `scanProjects`. Cada item tiene
   * path + name + branch + dirty. Empty array hasta el primer
   * scan completado.
   */
  const projectsFromDisk = ref<ProjectFromDisk[]>([]);

  /**
   * Sesiones descubiertas por `scanSessions`. Orden esperado:
   * descendente por `endedAtIso` (lo aplica el scanner antes de
   * mandar el batch).
   */
  const sessionsFromDisk = ref<SessionFromDisk[]>([]);

  /**
   * ISO del último scan completo (cualquiera de los dos eventos
   * lo actualiza). null hasta el primer scan. Lo consume el
   * Toolbar para mostrar "last scan Xs ago".
   */
  const lastScanIso = ref<string | null>(null);

  // === Actions ===

  /** Reemplaza la lista entera (los scanners son stateless, mandan todo). */
  function applyProjectsFromDisk(
    projects: ProjectFromDisk[],
    scannedAtIso: string,
  ): void {
    projectsFromDisk.value = projects.map((p) => ({ ...p }));
    lastScanIso.value = scannedAtIso;
  }

  function applySessionsFromDisk(
    sessions: SessionFromDisk[],
    scannedAtIso: string,
  ): void {
    sessionsFromDisk.value = sessions.map((s) => ({ ...s }));
    lastScanIso.value = scannedAtIso;
  }

  // === Getters ===

  /**
   * Sesiones agrupadas por project name. Lo consume el dropdown
   * del selector para sacar `M sessions` por proyecto + la sección
   * PAST SESSIONS para iterar.
   */
  const sessionsByProject = computed<Map<string, SessionFromDisk[]>>(() => {
    const map = new Map<string, SessionFromDisk[]>();
    for (const s of sessionsFromDisk.value) {
      const arr = map.get(s.project) ?? [];
      arr.push(s);
      map.set(s.project, arr);
    }
    return map;
  });

  /**
   * Sesiones del proyecto X filtradas para "PAST SESSIONS":
   * excluye las que están vivas como agente. La regla es:
   *
   *   - entrypoint=sdk-ts Y sessionId ∈ liveSessionIds → excluir.
   *   - cualquier otro entrypoint → incluir (chats del user, CLI, etc.).
   *
   * `liveSessionIds` viene del store de agentes (los que tienen
   * sessionId capturado y status running/pending). El llamador lo
   * inyecta para mantener el getter puro respecto al otro store.
   */
  function pastSessionsForProject(
    projectName: string,
    liveSessionIds: Set<string>,
  ): SessionFromDisk[] {
    const all = sessionsByProject.value.get(projectName) ?? [];
    return all.filter((s) => {
      if (s.entrypoint === 'sdk-ts' && liveSessionIds.has(s.sessionId)) {
        return false;
      }
      return true;
    });
  }

  /**
   * Cantidad de sesiones por proyecto. Útil para el dropdown
   * (mostrar `(N agents · M sessions)` por row). NO aplica el
   * filtro live — esto cuenta TODAS las sesiones del proyecto en
   * disco. El dedup contra agentes vivos solo afecta el render
   * de PAST SESSIONS, no el conteo en el selector.
   */
  function sessionCountFor(projectName: string): number {
    return sessionsByProject.value.get(projectName)?.length ?? 0;
  }

  /**
   * Lista plana de nombres de proyecto presentes EITHER en
   * `projectsFromDisk` o como project de alguna sesión. Sirve
   * cuando un user tiene sesiones de un proyecto que ya NO está
   * bajo `projectsRoot` — lo seguimos mostrando porque hay
   * historia útil.
   *
   * Devuelve un Set para que el caller pueda mergear con los
   * proyectos derivados de agentes vivos sin doble loop.
   */
  const projectNamesFromDisk = computed<Set<string>>(() => {
    const names = new Set<string>();
    for (const p of projectsFromDisk.value) names.add(p.name);
    for (const s of sessionsFromDisk.value) {
      if (s.project) names.add(s.project);
    }
    return names;
  });

  return {
    // state
    projectsFromDisk,
    sessionsFromDisk,
    lastScanIso,
    // actions
    applyProjectsFromDisk,
    applySessionsFromDisk,
    // getters
    sessionsByProject,
    projectNamesFromDisk,
    // helpers
    pastSessionsForProject,
    sessionCountFor,
  };
});
