<script setup lang="ts">
/**
 * LogStream — renderea LogEntry[] del ringbuffer del bridge.
 *
 * Patrón visual inspirado en el chat oficial de claude-code:
 * lista vertical de bullets, cada uno con un dot/icon a la izquierda
 * y contenido a la derecha. Las secciones IN/OUT de tool_use/result
 * se muestran como bloques `<pre>` monoespacio. Thinking blocks
 * dim italic. Texto del agente foreground default.
 *
 * Auto-scroll al bottom solo si el user está cerca (últimos 80px).
 * Si scrolleó hacia arriba, respetamos su posición — no le saltamos
 * el viewport.
 *
 * `toolUseId` correla tool_result con su tool_use previo. Hoy NO lo
 * usamos para indentar (los logs vienen secuenciales del ringbuffer
 * y los pares request/response son adyacentes en práctica); queda
 * el campo en el wire para refactor futuro si se desordenan.
 */

import { computed, nextTick, onMounted, onUpdated, ref } from 'vue';
import type { LogEntry } from '../../../shared/dashboard-protocol';
import { formatTokens } from '../../../shared/format';

const props = defineProps<{
  entries: LogEntry[];
}>();

// === Auto-scroll al bottom ===
//
// El listener del scroll guarda si el user está "cerca del bottom"
// (< 80px del fondo). Si sí, cada update repinta y mantenemos el
// scroll pegado al final. Si scrolleó hacia arriba, lo dejamos
// tranquilo — patrón estándar de chat clients.
//
// El scroll lo hacemos via requestAnimationFrame coalescido: si
// `onUpdated` dispara N veces en el mismo frame (varios entries
// nuevos en burst), solo medimos `scrollHeight` UNA vez por frame.
// Sin el rAF, cada update forzaba un reflow sincrónico al leer
// scrollHeight — caro a 1000 entries.
const containerRef = ref<HTMLElement | null>(null);
const stickToBottom = ref(true);
let scrollScheduled = false;

function onScroll(): void {
  const el = containerRef.value;
  if (!el) return;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  stickToBottom.value = distanceFromBottom < 80;
}

function scheduleScrollToBottom(): void {
  if (scrollScheduled || !stickToBottom.value) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    if (!stickToBottom.value) return;
    const el = containerRef.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  });
}

onMounted(() => {
  // El primer paint puede no haber medido todavía; esperamos al
  // siguiente tick antes del rAF para que scrollHeight sea válido.
  void nextTick(() => scheduleScrollToBottom());
});
onUpdated(() => {
  scheduleScrollToBottom();
});

// === Helpers de presentación ===
//
// Cada kind tiene su icon + color + label. Centralizado para que
// agregar un kind nuevo sea 1 cambio.
const KIND_PRESENTATION = {
  thinking: { icon: 'codicon-lightbulb', color: 'var(--color-warning)', label: 'Thinking' },
  text: { icon: 'codicon-comment', color: 'var(--foreground)', label: '' },
  tool_use: { icon: 'codicon-tools', color: 'var(--color-info)', label: '' },
  tool_result: { icon: 'codicon-arrow-small-right', color: 'var(--foreground-muted)', label: '' },
  usage: { icon: 'codicon-graph', color: 'var(--foreground-muted)', label: 'Usage' },
} as const satisfies Record<
  LogEntry['kind'],
  { icon: string; color: string; label: string }
>;

function presentationFor(kind: LogEntry['kind']) {
  return KIND_PRESENTATION[kind];
}

// === Formato del input de tool_use ===
//
// El input es `unknown` (lo que el SDK haya mandado). Si es objeto
// con keys conocidas comunes, formateamos pretty; sino JSON.stringify
// con indent. Truncamos largo (con sufijo "chars more" para que el
// user sepa que hay más).
function formatToolInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return truncateWithCounter(input, 600);
  try {
    return truncateWithCounter(JSON.stringify(input, null, 2), 600);
  } catch {
    return String(input);
  }
}

function formatToolResult(result: string | undefined): string {
  if (!result) return '';
  return truncateWithCounter(result, 1200);
}

/**
 * Variante de truncate que agrega "[truncated, N chars more]" para
 * que el user entienda que hay contenido oculto. La función simple
 * de shared no aporta ese sufijo informativo en bloques de log
 * que pueden ser muy largos.
 *
 * Usa el `truncate` de shared como base + agrega el counter.
 */
function truncateWithCounter(s: string, max: number): string {
  if (s.length <= max) return s;
  // No usamos shared.truncate acá porque su elipsis va dentro del
  // límite; nosotros queremos counter explícito post-corte.
  return s.slice(0, max) + `…\n[truncated, ${s.length - max} chars more]`;
}

function formatUsage(tokens: number | undefined): string {
  if (tokens === undefined || tokens === 0) return '';
  return `${formatTokens(tokens)} tokens`;
}

// Empty state si el ringbuffer está vacío (agente recién spawneado,
// pre-init, o evictado del registry).
const isEmpty = computed(() => props.entries.length === 0);
</script>

<template>
  <div ref="containerRef" class="log-stream" @scroll="onScroll">
    <div v-if="isEmpty" class="empty">
      <i class="codicon codicon-pulse" />
      <span>Waiting for the agent to start emitting events…</span>
    </div>

    <!-- key compuesta `ts-kind`: estable bajo shifts del ringbuffer
         (cuando entra el 1001, sale el 0 — los ts no cambian) y
         tolerante a bursts <1ms del SDK donde tool_use + tool_result
         caen en el mismo Date.now(). Sin key estable Vue re-creaba
         TODO el DOM al hacer FIFO. Si el kind también colisiona
         (raro), Vue degrade-a con warning sin crashear. -->
    <div
      v-for="entry in entries"
      :key="`${entry.ts}-${entry.kind}`"
      class="entry"
      :class="`kind-${entry.kind}`"
    >
      <!-- === Bullet con icono colored === -->
      <i
        class="codicon bullet"
        :class="presentationFor(entry.kind).icon"
        :style="{ color: presentationFor(entry.kind).color }"
      />

      <!-- === Contenido por kind === -->
      <div class="body">
        <!-- thinking: header + texto italic dim -->
        <template v-if="entry.kind === 'thinking'">
          <div class="row-1">
            <span class="label">{{ presentationFor(entry.kind).label }}</span>
          </div>
          <p class="thinking-text">{{ entry.text }}</p>
        </template>

        <!-- text: párrafo normal foreground default -->
        <template v-else-if="entry.kind === 'text'">
          <p class="text-block">{{ entry.text }}</p>
        </template>

        <!-- tool_use: header con name + bloque IN -->
        <template v-else-if="entry.kind === 'tool_use'">
          <div class="row-1">
            <span class="tool-name">{{ entry.name }}</span>
          </div>
          <pre v-if="formatToolInput(entry.input)" class="code-block in"><span class="prefix">IN</span>{{ formatToolInput(entry.input) }}</pre>
        </template>

        <!-- tool_result: bloque OUT (con marker error si aplica) -->
        <template v-else-if="entry.kind === 'tool_result'">
          <pre
            class="code-block out"
            :class="{ 'is-error': entry.isError }"
          ><span class="prefix">OUT{{ entry.isError ? ' (error)' : '' }}</span>{{ formatToolResult(entry.result) }}</pre>
        </template>

        <!-- usage: pill discreto -->
        <template v-else-if="entry.kind === 'usage'">
          <span class="usage-pill">{{ formatUsage(entry.tokensUsed) }}</span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.log-stream {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  overflow-y: auto;
  height: 100%;
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--foreground);
}

.empty {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--foreground-muted);
  font-style: italic;
  padding: 12px;
}
.empty .codicon {
  font-size: 14px;
}

.entry {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.bullet {
  font-size: 12px;
  line-height: 18px;
  flex-shrink: 0;
  margin-top: 2px;
}

.body {
  flex: 1;
  min-width: 0;
}

.row-1 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-warning);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.tool-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-info);
}

.thinking-text {
  font-style: italic;
  color: var(--foreground-muted);
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
}
.text-block {
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  line-height: 1.5;
}

/* === Bloques IN/OUT estilo monospaced con prefix === */
.code-block {
  margin: 0;
  padding: 8px 10px 8px 36px;
  background: rgb(127 127 127 / 0.08);
  border-left: 2px solid var(--border-subtle);
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-x: auto;
  position: relative;
  color: var(--foreground);
}
.code-block .prefix {
  position: absolute;
  left: 8px;
  top: 8px;
  font-size: 10px;
  font-weight: 700;
  color: var(--foreground-muted);
  letter-spacing: 0.5px;
}
.code-block.in {
  border-left-color: var(--color-info);
}
.code-block.out {
  border-left-color: var(--foreground-muted);
}
.code-block.is-error {
  border-left-color: var(--color-error);
  background: rgb(244 67 54 / 0.06);
}
.code-block.is-error .prefix {
  color: var(--color-error);
}

.usage-pill {
  display: inline-block;
  padding: 2px 8px;
  font-size: 10.5px;
  font-family: var(--font-mono);
  color: var(--foreground-muted);
  background: rgb(127 127 127 / 0.12);
  border-radius: 8px;
}
</style>
