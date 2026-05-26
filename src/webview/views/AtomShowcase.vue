<script setup lang="ts">
/**
 * AtomShowcase — galería de los átomos del dashboard en aislamiento.
 *
 * Mientras esta fase no ensamble las secciones reales (NOW PLAYING
 * / UP NEXT / RECENT con sus cards completas — eso es 1.3.c), esta
 * vista permite validar visualmente cada átomo en todas sus
 * variantes y verificar que:
 *
 *   - Las CSS vars del @theme resuelven a colores correctos.
 *   - La animación `pulse` corre (halo difuso visible).
 *   - La animación width del ContextBar se ve al cargar.
 *   - `white-space: nowrap` del ModelBadge funciona en sidebars
 *     angostos.
 *   - El font codicons carga real (bonus: validamos los 3 glifos
 *     que la fase 1.3.c va a usar en RECENT — check, warning,
 *     circle-slash).
 *   - El Pinia store devuelve la mock data (renderizamos counts).
 *
 * En 1.3.c esta vista pasa a ser regression visual cuando se
 * toquen átomos; el App.vue rota a renderear la vista real.
 */

import { computed } from 'vue';
import { useAgentsStore } from '../stores/useAgentsStore';
import StatusDot from '../components/atoms/StatusDot.vue';
import ContextBar from '../components/atoms/ContextBar.vue';
import ModelBadge from '../components/atoms/ModelBadge.vue';
import PriorityPill from '../components/atoms/PriorityPill.vue';
import FailedBadge from '../components/atoms/FailedBadge.vue';

const store = useAgentsStore();

// === Counters derivados, para validar el store ===

const counts = computed(() => ({
  projects: store.projects.length,
  agents: store.agents.length,
  nowPlaying: store.nowPlaying.length,
  upNext: store.upNext.length,
  recent: store.recent.length,
  failed: store.recentFailedCount,
  active: store.projectsByLifecycle.active.length,
  idle: store.projectsByLifecycle.idle.length,
  inactive: store.projectsByLifecycle.inactive.length,
}));
</script>

<template>
  <div class="showcase">
    <!-- === Store sanity check === -->
    <section>
      <h2>store · sanity check</h2>
      <ul class="counters">
        <li>projects: {{ counts.projects }}</li>
        <li>agents: {{ counts.agents }}</li>
        <li>now playing: {{ counts.nowPlaying }}</li>
        <li>up next: {{ counts.upNext }}</li>
        <li>recent: {{ counts.recent }}</li>
        <li>recent failed: {{ counts.failed }}</li>
        <li>active: {{ counts.active }}</li>
        <li>idle: {{ counts.idle }}</li>
        <li>inactive: {{ counts.inactive }}</li>
      </ul>
    </section>

    <!-- === StatusDot === -->
    <section>
      <h2>StatusDot</h2>
      <div class="row">
        <span class="cell"><StatusDot status="running" /> running</span>
        <span class="cell"><StatusDot status="running" pulse /> running · pulse</span>
        <span class="cell"><StatusDot status="pending" /> pending</span>
        <span class="cell"><StatusDot status="done" /> done</span>
        <span class="cell"><StatusDot status="failed" /> failed</span>
        <span class="cell"><StatusDot status="cancelled" /> cancelled</span>
        <span class="cell"><StatusDot status="active" /> active</span>
        <span class="cell"><StatusDot status="idle" /> idle (ring)</span>
        <span class="cell"><StatusDot status="inactive" /> inactive (ring)</span>
      </div>
    </section>

    <!-- === ContextBar === -->
    <section>
      <h2>ContextBar</h2>
      <div class="stack">
        <ContextBar :pct="18" />
        <ContextBar :pct="29" :tokens-used="58_000" />
        <ContextBar :pct="58" :tokens-used="116_000" />
        <ContextBar :pct="72" :tokens-used="144_000" />
        <ContextBar :pct="92" :tokens-used="184_000" />
      </div>
    </section>

    <!-- === ModelBadge === -->
    <section>
      <h2>ModelBadge</h2>
      <div class="row">
        <ModelBadge model="Opus 4.7" />
        <ModelBadge model="Sonnet" />
        <ModelBadge model="Sonnet 4.5" />
        <ModelBadge model="Haiku 4.5" />
      </div>
    </section>

    <!-- === PriorityPill === -->
    <section>
      <h2>PriorityPill</h2>
      <div class="row">
        <PriorityPill priority="LOW" />
        <PriorityPill priority="MED" />
        <PriorityPill priority="HIGH" />
      </div>
    </section>

    <!-- === FailedBadge === -->
    <section>
      <h2>FailedBadge</h2>
      <div class="row">
        <span class="cell"
          ><FailedBadge :count="0" /><em
            style="color: var(--foreground-muted); font-size: 11px"
          >
            count=0 oculto</em
          ></span
        >
        <FailedBadge :count="1" />
        <FailedBadge :count="3" />
        <FailedBadge :count="12" />
      </div>
    </section>

    <!-- === Bonus: codicons (validar font carga real) === -->
    <section>
      <h2>codicons · bonus</h2>
      <div class="row codicon-row">
        <span class="cell"
          ><i class="codicon codicon-check" /><span class="cell-label">check (done)</span></span
        >
        <span class="cell"
          ><i class="codicon codicon-warning" /><span class="cell-label">warning (failed)</span></span
        >
        <span class="cell"
          ><i class="codicon codicon-circle-slash" /><span class="cell-label"
            >circle-slash (cancelled)</span
          ></span
        >
        <span class="cell"
          ><i class="codicon codicon-folder" /><span class="cell-label">folder (project)</span></span
        >
        <span class="cell"
          ><i class="codicon codicon-chevron-down" /><span class="cell-label"
            >chevron-down (selector)</span
          ></span
        >
      </div>
    </section>
  </div>
</template>

<style scoped>
.showcase {
  display: flex;
  flex-direction: column;
  gap: 18px;
  font-family: var(--font-ui);
  color: var(--foreground);
}

section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

h2 {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--foreground-muted);
  margin: 0;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border-subtle);
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--foreground);
}

.cell-label {
  color: var(--foreground-muted);
}

.counters {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 4px 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--foreground-muted);
}

.codicon-row .codicon {
  font-size: 14px;
  color: var(--foreground);
}
</style>
