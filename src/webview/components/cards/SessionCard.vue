<script setup lang="ts">
/**
 * SessionCard — card de una sesión histórica de Claude Code.
 *
 * Layout (similar a AgentCardRecent, una línea):
 *
 *   [stripe 2px] [icon] {firstPrompt}            {branch · time · Resume}
 *
 * Diferencias vs AgentCardRecent:
 *
 *   - El nombre principal es el `firstPrompt` truncado (el primer
 *     mensaje del user al inicio de la sesión). Funciona como "qué
 *     estaba haciendo".
 *   - El botón Resume invoca `request_resume_session` al extension
 *     host, que abre `claude --resume <sessionId>` en una terminal
 *     nueva con cwd correcto.
 *   - El stripe + icon reflejan el status inferido del JSONL:
 *     done / failed / interrupted (este último es propio del
 *     scanner — no existe en agentes vivos).
 *
 * El click sobre la card (fuera del botón Resume) NO hace nada
 * todavía — el detail panel histórico entra en una iteración futura.
 */

import { computed, ref } from 'vue';
import type { SessionFromDisk } from '../../../shared/dashboard-protocol';
import { formatRelative } from '../../utils/format';
import { postToExtension } from '../../composables/usePostToExtension';

const props = withDefaults(
  defineProps<{
    session: SessionFromDisk;
    /**
     * Estado global de expand controlado por el botón del header
     * de PAST SESSIONS. Cuando true, TODAS las cards expanden.
     * Cuando false, cada card mantiene su propio estado individual
     * (click sobre el prompt hace toggle local).
     */
    expanded?: boolean;
  }>(),
  { expanded: false },
);

// Estado local de expand individual. El "efectivo" combina ambos:
// si el global está prendido todas expanden; si está apagado, cada
// card sigue su flag individual. Así el user puede tener la lista
// compacta global Y expandir 1-2 específicas sin perder contexto.
const localExpanded = ref(false);
const isExpanded = computed(() => props.expanded || localExpanded.value);

// Texto a mostrar: corto cuando colapsado, largo cuando expandido.
// Si el wire no trae firstPromptFull (sesiones viejas hidratadas de
// versiones previas del plugin) caemos al firstPrompt corto.
const promptText = computed(() =>
  isExpanded.value
    ? props.session.firstPromptFull || props.session.firstPrompt
    : props.session.firstPrompt,
);

function onPromptClick(event: MouseEvent): void {
  // Click en el área del prompt expande/colapsa esta card individual.
  // No interfiere con el botón Resume (tiene stopPropagation propio).
  event.stopPropagation();
  localExpanded.value = !localExpanded.value;
}

// === Map de presentación por status inferido ===
//
// `done` y `failed` reusan los tokens del agente. `interrupted` es
// específico del scanner — colorearlo igual que `cancelled` evita
// ruido visual + lo asocia con "el user mató esto, no es un error
// del sistema".

const STATUS_PRESENTATION = {
  done: { color: 'var(--stripe-done)', iconClass: 'codicon-check' },
  failed: { color: 'var(--stripe-failed)', iconClass: 'codicon-warning' },
  interrupted: {
    color: 'var(--stripe-cancelled)',
    iconClass: 'codicon-debug-pause',
  },
} as const satisfies Record<
  SessionFromDisk['status'],
  { color: string; iconClass: string }
>;

const presentation = computed(() => STATUS_PRESENTATION[props.session.status]);

// === Meta secundaria — branch + tiempo relativo + entrypoint tag ===
//
// branch puede ser vacío (detached HEAD o no-git). Mostramos guion
// para que la grilla quede pareja en lugar de saltar la columna.

const branchLabel = computed(() => props.session.branch || '—');
const timeAgo = computed(() => formatRelative(props.session.endedAtIso) + ' ago');

/**
 * Etiqueta del origen. Hoy lo mostramos solo para `sdk-ts`
 * (sesiones lanzadas por el orchestrator); el resto queda implícito
 * para no saturar visualmente.
 */
const entrypointBadge = computed(() => {
  if (props.session.entrypoint === 'sdk-ts') return 'orchestrator';
  return '';
});

function onResume(event: MouseEvent): void {
  // El click llega también al contenedor; evitamos burbuja para
  // que un futuro click handler de la card no se dispare al usar
  // Resume.
  event.stopPropagation();
  postToExtension({
    type: 'request_resume_session',
    sessionId: props.session.sessionId,
    cwd: props.session.cwd,
    firstPrompt: props.session.firstPrompt,
  });
}
</script>

<template>
  <div
    class="card"
    :class="{ 'is-expanded': isExpanded }"
    :style="{ borderLeftColor: presentation.color }"
    role="listitem"
  >
    <i
      class="codicon icon"
      :class="presentation.iconClass"
      :style="{ color: presentation.color }"
    />
    <span
      class="prompt"
      :class="{ 'prompt-multiline': isExpanded }"
      :title="isExpanded ? 'Click to collapse' : 'Click to expand'"
      @click="onPromptClick"
    >
      {{ promptText }}
    </span>
    <span class="meta">
      <span class="branch">{{ branchLabel }}</span>
      <span class="dot-sep">·</span>
      <span class="time">{{ timeAgo }}</span>
      <span v-if="entrypointBadge" class="entry-badge">{{ entrypointBadge }}</span>
    </span>
    <button
      type="button"
      class="resume-btn"
      :title="`Resume claude --resume ${session.sessionId}`"
      @click="onResume"
    >
      <i class="codicon codicon-debug-restart" />
      Resume
    </button>
  </div>
</template>

<style scoped>
.card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 4px 8px;
  border-radius: 3px;
  border-left: 2px solid var(--color-muted);
  opacity: 0.92;
}
/* Cuando el padre activa expand, alineamos arriba para que las
 * cards con prompt corto no se desalineen con las largas. */
.card.is-expanded {
  align-items: flex-start;
  padding-top: 6px;
  padding-bottom: 6px;
}
.card:hover {
  background: rgb(255 255 255 / 0.04);
}

.icon {
  width: 12px;
  font-size: 12px;
  text-align: center;
  flex-shrink: 0;
}

.prompt {
  flex: 1;
  font-size: 12px;
  color: var(--foreground);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0;
  cursor: pointer;
}
.prompt:hover {
  color: var(--focus-ring);
}
/* Estado expandido: texto multilínea sin límite — el firstPromptFull
 * ya está capped a 400 chars en el parser, lo que produce ~5-6
 * líneas legibles. Sin line-clamp porque ahora SÍ tenemos texto
 * suficiente para mostrar; el cap de chars hace de freno natural. */
.prompt.prompt-multiline {
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: anywhere;
  line-height: 1.45;
  text-overflow: clip;
}

.meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--foreground-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.branch {
  font-family: var(--font-mono);
  /* Limit ancho para que branches largas no empujen el resto. */
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dot-sep {
  opacity: 0.7;
}

.entry-badge {
  margin-left: 4px;
  padding: 0 5px;
  font-size: 9px;
  font-weight: 500;
  border-radius: 8px;
  background: rgb(33 150 243 / 0.18);
  color: var(--foreground);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.resume-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  font-size: 10px;
  font-weight: 500;
  border-radius: 3px;
  border: 1px solid var(--border-input);
  background: transparent;
  color: var(--foreground);
  cursor: pointer;
  flex-shrink: 0;
}
.resume-btn:hover {
  background: rgb(255 255 255 / 0.08);
  border-color: var(--foreground-muted);
}
.resume-btn .codicon {
  font-size: 10px;
}
</style>
