/* ================================================================
 * useAgentsStore.ts — Estado del dashboard.
 *
 * Pinia store con la data mock que pueblan las vistas mientras el
 * backend real (MCP → AgentRunner → postMessage) no esté cableado.
 * El cableo es Fase 1.4 — acá NO hay actions de mutación todavía,
 * solo state hardcoded + getters derivados que las vistas consumen.
 *
 * Estilo: composition API (`defineStore('agents', () => {...})`)
 * para alinear con `<script setup>` de los componentes.
 *
 * Mock data viene literal del KANBAN_DESIGN_BRIEF.md §11. Los 12
 * agentes RECENT incluyen 1 failed (rebase-conflicts) para que el
 * FailedBadge de la sección header sea visible. Los proyectos
 * tienen lifecycle pre-calculado (active/idle/inactive) según el
 * algoritmo de §10 del brief — en 1.4 esto se moverá a un getter
 * derivado cuando el wire devuelva agentes en vez de proyectos.
 * ================================================================ */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Agent, Project } from '../types';

// === Mock data — proyectos ===

const PROJECTS: Project[] = [
  {
    id: 'p-001',
    name: 'ecuadorian-hr18',
    lifecycle: 'active',
    lastUpdateIso: '2026-05-25T14:32:50Z',
    activeTask: 'tarea_10794',
  },
  {
    id: 'p-002',
    name: 'trescloud-restrict-move-unlink',
    lifecycle: 'active',
    lastUpdateIso: '2026-05-25T14:32:50Z',
    activeTask: 'tarea_10795',
  },
  {
    id: 'p-003',
    name: 'revision_inteligente_prs',
    lifecycle: 'active',
    lastUpdateIso: '2026-05-25T14:33:00Z',
    activeTask: 'tarea_10796',
  },
  {
    id: 'p-004',
    name: 'purchase-and-imports_263',
    lifecycle: 'active',
    lastUpdateIso: '2026-05-25T14:28:00Z',
    activeTask: 'tarea_10780',
  },
  {
    id: 'p-005',
    name: 'tarea-7f-backport-v16',
    lifecycle: 'idle',
    lastUpdateIso: '2026-05-25T08:30:00Z',
    activeTask: 'tarea_10720',
  },
  {
    id: 'p-006',
    name: 'equipo-ya-mcp-spec',
    lifecycle: 'inactive',
    lastUpdateIso: '2026-05-22T17:00:00Z',
    activeTask: 'tarea_10650',
  },
];

// === Mock data — agentes ===
//
// Distribución pensada para llenar las 3 secciones del dashboard:
//   - 3 running (NOW PLAYING en 2 project groups)
//   - 3 pending (UP NEXT en 3 project groups con prioridades L/M/H)
//   - 6 recent (RECENT con 1 failed para activar el badge rojo;
//     dejo 12 como dice el brief sumando 2 inventados que cubren
//     los project groups active sin RECENT).

const AGENTS: Agent[] = [
  // --- NOW PLAYING ---
  {
    id: 'a-001',
    name: 'migrate-payroll-tables',
    status: 'running',
    project: 'ecuadorian-hr18',
    task: 'tarea_10794',
    branch: 'feature/SL-10794',
    batchId: 'b-001',
    subtitle: 'account.move + payslip.line',
    model: 'Opus 4.7',
    startedAtIso: '2026-05-25T14:30:36Z',
    elapsedMs: 134_000, // 2m 14s
    contextUsedPct: 58,
    currentTool: 'Edit',
    tokensUsed: 116_000,
  },
  {
    id: 'a-002',
    name: 'test-iess-export',
    status: 'running',
    project: 'ecuadorian-hr18',
    task: 'tarea_10794',
    branch: 'feature/SL-10794',
    batchId: 'b-001',
    subtitle: 'tests/test_iess_xml',
    model: 'Sonnet',
    startedAtIso: '2026-05-25T14:32:08Z',
    elapsedMs: 42_000, // 0m 42s
    contextUsedPct: 18,
    currentTool: 'Bash',
    tokensUsed: 36_000,
  },
  {
    id: 'a-003',
    name: 'audit-unlink-overrides',
    status: 'running',
    project: 'trescloud-restrict-move-unlink',
    task: 'tarea_10795',
    branch: 'feature/SL-10795',
    batchId: 'b-002',
    subtitle: 'res.company override scan',
    model: 'Sonnet',
    startedAtIso: '2026-05-25T14:31:46Z',
    elapsedMs: 64_000, // 1m 04s
    contextUsedPct: 29,
    currentTool: 'Glob',
    tokensUsed: 58_000,
  },

  // --- UP NEXT ---
  {
    id: 'a-004',
    name: 'pot-sync-translations',
    status: 'pending',
    project: 'ecuadorian-hr18',
    task: 'tarea_10794',
    branch: 'feature/SL-10794',
    batchId: 'b-003',
    priority: 'HIGH',
    queuedSinceIso: '2026-05-25T14:30:00Z', // 4m ago
  },
  {
    id: 'a-005',
    name: 'audit-pr-batch-may',
    status: 'pending',
    project: 'revision_inteligente_prs',
    task: 'tarea_10796',
    branch: 'feature/SL-10796',
    batchId: 'b-004',
    priority: 'MED',
    queuedSinceIso: '2026-05-25T14:33:00Z', // 1m ago
  },
  {
    id: 'a-006',
    name: 'generate-import-report',
    status: 'pending',
    project: 'purchase-and-imports_263',
    task: 'tarea_10780',
    branch: 'feature/SL-10780',
    batchId: 'b-005',
    priority: 'LOW',
    queuedSinceIso: '2026-05-25T14:28:00Z', // 6m ago
  },

  // --- RECENT — ecuadorian-hr18 ---
  {
    id: 'a-007',
    name: 'refactor-hr-payslip',
    status: 'done',
    project: 'ecuadorian-hr18',
    task: 'tarea_10794',
    branch: 'feature/SL-10794',
    batchId: 'b-006',
    completedAtIso: '2026-05-25T14:25:00Z', // 9m ago
    durationMs: 184_000,
    tokensUsed: 12_450,
  },
  {
    id: 'a-008',
    name: 'tests-payroll-edge',
    status: 'done',
    project: 'ecuadorian-hr18',
    task: 'tarea_10794',
    branch: 'feature/SL-10794',
    batchId: 'b-006',
    completedAtIso: '2026-05-25T14:18:00Z',
    durationMs: 138_000,
    tokensUsed: 8_100,
  },
  {
    id: 'a-009',
    name: 'deploy-staging-hr',
    status: 'cancelled',
    project: 'ecuadorian-hr18',
    task: 'tarea_10794',
    branch: 'feature/SL-10794',
    batchId: 'b-007',
    completedAtIso: '2026-05-25T14:15:00Z',
    durationMs: 3_000,
    reason: 'cancelled by user',
  },
  {
    id: 'a-010',
    name: 'docs-iess-update',
    status: 'done',
    project: 'ecuadorian-hr18',
    task: 'tarea_10794',
    branch: 'feature/SL-10794',
    batchId: 'b-008',
    completedAtIso: '2026-05-25T14:10:00Z',
    durationMs: 107_000,
    tokensUsed: 4_200,
  },

  // --- RECENT — tarea-7f-backport-v16 (idle, 6h ago) ---
  {
    id: 'a-011',
    name: 'merge-backport-fixes',
    status: 'done',
    project: 'tarea-7f-backport-v16',
    task: 'tarea_10720',
    branch: 'feature/SL-10720',
    batchId: 'b-009',
    completedAtIso: '2026-05-25T08:30:00Z',
    durationMs: 245_000,
    tokensUsed: 18_900,
  },
  {
    id: 'a-012',
    name: 'rebase-conflicts',
    status: 'failed',
    project: 'tarea-7f-backport-v16',
    task: 'tarea_10720',
    branch: 'feature/SL-10720',
    batchId: 'b-009',
    completedAtIso: '2026-05-25T08:15:00Z',
    durationMs: 89_000,
    reason: 'merge conflict not resolvable',
  },
  {
    id: 'a-013',
    name: 'smoke-tests',
    status: 'done',
    project: 'tarea-7f-backport-v16',
    task: 'tarea_10720',
    branch: 'feature/SL-10720',
    batchId: 'b-010',
    completedAtIso: '2026-05-25T08:00:00Z',
    durationMs: 160_000,
    tokensUsed: 5_500,
  },
  {
    id: 'a-014',
    name: 'rebuild-tests-mcp',
    status: 'done',
    project: 'tarea-7f-backport-v16',
    task: 'tarea_10720',
    branch: 'feature/SL-10720',
    batchId: 'b-010',
    completedAtIso: '2026-05-25T07:45:00Z',
    durationMs: 198_000,
    tokensUsed: 10_200,
  },

  // --- RECENT — equipo-ya-mcp-spec (inactive, 3 días ago) ---
  {
    id: 'a-015',
    name: 'audit-mcp-contract',
    status: 'done',
    project: 'equipo-ya-mcp-spec',
    task: 'tarea_10650',
    branch: 'feature/SL-10650',
    batchId: 'b-011',
    completedAtIso: '2026-05-22T17:00:00Z',
    durationMs: 285_000,
    tokensUsed: 22_300,
  },
  {
    id: 'a-016',
    name: 'spec-mcp-tools',
    status: 'done',
    project: 'equipo-ya-mcp-spec',
    task: 'tarea_10650',
    branch: 'feature/SL-10650',
    batchId: 'b-011',
    completedAtIso: '2026-05-22T15:30:00Z',
    durationMs: 312_000,
    tokensUsed: 26_100,
  },

  // --- RECENT — 2 más para sumar 12, en proyectos active con historia ---
  {
    id: 'a-017',
    name: 'finalize-restrict-module',
    status: 'done',
    project: 'trescloud-restrict-move-unlink',
    task: 'tarea_10795',
    branch: 'feature/SL-10795',
    batchId: 'b-012',
    completedAtIso: '2026-05-25T13:50:00Z',
    durationMs: 92_000,
    tokensUsed: 6_400,
  },
  {
    id: 'a-018',
    name: 'review-pr-batch',
    status: 'done',
    project: 'revision_inteligente_prs',
    task: 'tarea_10796',
    branch: 'feature/SL-10796',
    batchId: 'b-013',
    completedAtIso: '2026-05-25T13:30:00Z',
    durationMs: 215_000,
    tokensUsed: 14_800,
  },
];

// === Threshold helpers ===

/**
 * Now de referencia para el mock. Hardcoded para que los getters
 * derivados sean reproducibles (idle vs inactive depende de "ahora
 * - completed_at >= 24h"). En 1.4 esto pasa a Date.now() real y
 * los timestamps los emite el backend.
 */
const MOCK_NOW_ISO = '2026-05-25T14:34:30Z';
const MOCK_NOW_MS = new Date(MOCK_NOW_ISO).getTime();
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// === Store ===

export const useAgentsStore = defineStore('agents', () => {
  // State — refs para que sea reactivo aunque hoy no se mute.
  const projects = ref<Project[]>(PROJECTS);
  const agents = ref<Agent[]>(AGENTS);

  // --- Getters: secciones del dashboard ---

  const nowPlaying = computed<Agent[]>(() =>
    agents.value.filter((a) => a.status === 'running'),
  );

  const upNext = computed<Agent[]>(() =>
    agents.value.filter((a) => a.status === 'pending'),
  );

  /**
   * RECENT — done / failed / cancelled ordenados por completed_at
   * descendente (más reciente primero). El brief lo muestra así en
   * el wireframe ASCII de la vista Single project.
   */
  const recent = computed<Agent[]>(() =>
    agents.value
      .filter(
        (a) =>
          a.status === 'done' || a.status === 'failed' || a.status === 'cancelled',
      )
      .slice()
      .sort((a, b) => {
        // El sort por iso string funciona porque ISO 8601 ordena
        // lexicograficamente igual que cronológicamente.
        const aIso = a.completedAtIso ?? '';
        const bIso = b.completedAtIso ?? '';
        return bIso.localeCompare(aIso);
      }),
  );

  /**
   * Cantidad de failed en las últimas 24h. Alimenta el FailedBadge
   * del section header de RECENT — el badge solo se renderiza
   * cuando este getter > 0.
   */
  const recentFailedCount = computed<number>(
    () =>
      recent.value.filter((a) => {
        if (a.status !== 'failed') return false;
        if (!a.completedAtIso) return false;
        const ageMs = MOCK_NOW_MS - new Date(a.completedAtIso).getTime();
        return ageMs < TWENTY_FOUR_HOURS_MS;
      }).length,
  );

  // --- Getters: proyectos agrupados por lifecycle ---

  /**
   * Proyectos agrupados por lifecycle, para el dropdown del project
   * selector que los muestra en 3 bloques separados por divider.
   * Orden dentro de cada bloque: alfabético por nombre (en 1.4 el
   * brief permite cambiar a "más reciente started_at desc" para
   * active y "más reciente completed_at desc" para idle/inactive).
   */
  const projectsByLifecycle = computed(() => {
    const byLifecycle = {
      active: [] as Project[],
      idle: [] as Project[],
      inactive: [] as Project[],
    };
    for (const p of projects.value) {
      byLifecycle[p.lifecycle].push(p);
    }
    for (const key of ['active', 'idle', 'inactive'] as const) {
      byLifecycle[key].sort((a, b) => a.name.localeCompare(b.name));
    }
    return byLifecycle;
  });

  return {
    projects,
    agents,
    nowPlaying,
    upNext,
    recent,
    recentFailedCount,
    projectsByLifecycle,
  };
});
