<script setup lang="ts">
/**
 * AgentDetailView — vista del editor tab cuando el webview se
 * monta en modo `detail` (window.__claudeOrchestrator.mode='detail').
 *
 * Responsabilidades:
 *   1. Pedir hidratación del log al bridge cuando monta
 *      (`request_hydrate_logs`).
 *   2. Renderear header con name + project · branch + status badge +
 *      botón Cancel inline si running.
 *   3. Pasar el log per-agent al LogStream para renderear el stream.
 *
 * El AgentId viene inyectado en window al construir el panel
 * (DetailPanelManager). El composable `useDetailMode` lo lee.
 *
 * Live updates: el dispatcher `useDashboardBridge` ya cablea
 * `agent_log` → store.appendLog y `agent_log_history` →
 * store.replaceLogsForAgent. Acá solo leemos del store reactivamente.
 */

import { computed, onMounted } from 'vue';
import { useAgentsStore } from '../stores/useAgentsStore';
import { useDetailMode } from '../composables/useDetailMode';
import { useNow } from '../composables/useNow';
import { postToExtension } from '../composables/usePostToExtension';
import { formatCostUsd, formatElapsed, formatTokens } from '../utils/format';
import StatusDot from '../components/atoms/StatusDot.vue';
import ModelBadge from '../components/atoms/ModelBadge.vue';
import LogStream from '../components/detail/LogStream.vue';

const detail = useDetailMode();
const store = useAgentsStore();

// agentId viene del global inyectado. En modo sidebar este componente
// no se monta; en modo detail asume agentId presente.
const agentId = computed(() => detail.agentId);

const agent = computed(() => {
  if (!agentId.value) return undefined;
  return store.agents.find((a) => a.id === agentId.value);
});

const logEntries = computed(() => {
  if (!agentId.value) return [];
  return store.logsByAgent[agentId.value] ?? [];
});

// === Elapsed live ===
const now = useNow();
const elapsedText = computed(() => {
  const a = agent.value;
  if (!a) return '';
  if (a.status === 'running' && a.startedAtIso) {
    const started = Date.parse(a.startedAtIso);
    if (Number.isFinite(started)) {
      return formatElapsed(now.value - started);
    }
  }
  if (a.durationMs !== undefined) return formatElapsed(a.durationMs);
  return '';
});

// === Lookup por status para el dot del header ===
const STATUS_DOT_KIND = {
  running: 'running',
  pending: 'pending',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;

const dotKind = computed(() => {
  const a = agent.value;
  if (!a) return 'done';
  return STATUS_DOT_KIND[a.status] ?? 'done';
});

// === Handlers footer ===
function onCancel(): void {
  if (!agent.value || agent.value.status !== 'running') return;
  postToExtension({ type: 'request_cancel', agentId: agent.value.id });
}
function onOpenInChat(): void {
  if (!agent.value?.sessionId) return;
  postToExtension({ type: 'request_open', agentId: agent.value.id });
}

// === Hidratación inicial ===
//
// Pedimos el ringbuffer del bridge al mount. El bridge responde con
// `agent_log_history` que el dispatcher empuja al store via
// `replaceLogsForAgent`. Después los entries nuevos llegan vía
// `agent_log` normal.
onMounted(() => {
  if (!agentId.value) return;
  postToExtension({ type: 'request_hydrate_logs', agentId: agentId.value });
});

const isRunning = computed(() => agent.value?.status === 'running');
const hasSessionId = computed(() => !!agent.value?.sessionId);
</script>

<template>
  <div v-if="!agent" class="missing">
    <i class="codicon codicon-question" />
    <p>Agent <code>{{ agentId }}</code> not found.</p>
    <p class="hint">
      It may have been evicted after 30 days, or never spawned. Open
      the dashboard sidebar to see the current list.
    </p>
  </div>

  <div v-else class="detail">
    <!-- === Header: name + meta + status === -->
    <header class="header">
      <div class="title-row">
        <StatusDot :status="dotKind" :pulse="isRunning" />
        <h1 class="name">{{ agent.name }}</h1>
        <ModelBadge v-if="agent.model" :model="agent.model" />
        <span v-if="elapsedText" class="elapsed">{{ elapsedText }}</span>
      </div>
      <div class="meta-row">
        <span class="meta-chip">{{ agent.project }}</span>
        <span v-if="agent.task" class="meta-chip">{{ agent.task }}</span>
        <span v-if="agent.branch" class="meta-chip mono">{{ agent.branch }}</span>
        <span class="status-chip" :class="`status-${agent.status}`">{{ agent.status }}</span>
        <span v-if="agent.tokensUsed" class="meta-chip">
          <i class="codicon codicon-symbol-numeric" />
          {{ formatTokens(agent.tokensUsed) }} tokens
        </span>
        <!-- El chip de costo siempre se muestra: mid-run el SDK no
             expone total_cost_usd hasta el `result` final, así que
             formatCostUsd(_, status) devuelve "computing…" en running
             en lugar de "$0.00" engañoso. Para terminados normales
             mostramos el valor o "$0.00" si literalmente fue cero. -->
        <span
          class="meta-chip cost"
          :class="{ pending: agent.status === 'running' && !agent.costUsd }"
        >
          {{ formatCostUsd(agent.costUsd, agent.status) }}
        </span>
      </div>
    </header>

    <!-- === Body: LogStream con auto-scroll === -->
    <LogStream :entries="logEntries" class="stream" />

    <!-- === Footer: acciones contextuales === -->
    <footer class="footer">
      <button
        v-if="hasSessionId"
        type="button"
        class="ftr-btn"
        @click="onOpenInChat"
      >
        <i class="codicon codicon-link-external" />
        Open in Claude chat
      </button>
      <button
        v-if="isRunning"
        type="button"
        class="ftr-btn destructive"
        @click="onCancel"
      >
        <i class="codicon codicon-close" />
        Cancel agent
      </button>
    </footer>
  </div>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--background-view);
  color: var(--foreground);
  font-family: var(--font-ui);
}

.missing {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
  gap: 8px;
  color: var(--foreground-muted);
  padding: 32px;
  text-align: center;
}
.missing .codicon {
  font-size: 32px;
  opacity: 0.5;
}
.missing code {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 2px 6px;
  background: rgb(127 127 127 / 0.12);
  border-radius: 3px;
}
.missing .hint {
  font-size: 12px;
  max-width: 480px;
  line-height: 1.5;
}

/* === Header === */
.header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.name {
  flex: 1;
  font-size: 16px;
  font-weight: 600;
  margin: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.elapsed {
  font-size: 12px;
  color: var(--foreground-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.meta-chip {
  font-size: 11px;
  color: var(--foreground-muted);
  padding: 2px 8px;
  background: rgb(127 127 127 / 0.1);
  border-radius: 3px;
}
.meta-chip.mono {
  font-family: var(--font-mono);
}
.meta-chip.cost {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  color: var(--foreground);
}
/* Estado "computing…" mid-run: italic dim para distinguirlo visualmente
 * de un valor real (ej. "$0.00" terminal). */
.meta-chip.cost.pending {
  font-style: italic;
  font-weight: 400;
  opacity: 0.7;
}
.meta-chip .codicon {
  font-size: 11px;
  vertical-align: -1px;
  opacity: 0.7;
  margin-right: 2px;
}
.status-chip {
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 2px 8px;
  border-radius: 3px;
}
.status-chip.status-running {
  background: rgb(33 150 243 / 0.15);
  color: var(--color-info);
}
.status-chip.status-pending {
  background: rgb(255 152 0 / 0.15);
  color: var(--color-warning);
}
.status-chip.status-done {
  background: rgb(76 175 80 / 0.15);
  color: var(--color-success);
}
.status-chip.status-failed {
  background: rgb(244 67 54 / 0.15);
  color: var(--color-error);
}
.status-chip.status-cancelled {
  background: rgb(127 127 127 / 0.18);
  color: var(--foreground-muted);
}

/* === Body === */
.stream {
  flex: 1;
  min-height: 0;
}

/* === Footer === */
.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.ftr-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 12px;
  font-family: var(--font-ui);
  background: var(--background-button-secondary);
  color: var(--foreground);
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  cursor: pointer;
}
.ftr-btn:hover {
  background: rgb(255 255 255 / 0.06);
}
.ftr-btn.destructive {
  color: var(--color-error);
  border-color: rgb(244 67 54 / 0.4);
}
.ftr-btn.destructive:hover {
  background: rgb(244 67 54 / 0.1);
}
.ftr-btn .codicon {
  font-size: 12px;
}
</style>
