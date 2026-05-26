<script setup lang="ts">
/**
 * ProjectGroupHeader — header con 2 líneas dentro de un project
 * group container.
 *
 * Layout (HANDOFF §2.7):
 *   📁 {project-name}                 ← línea 1 (UI font, 12px)
 *      tarea_NNNNN · feature/SL-XXX   ← línea 2 (mono muted, 10.5px)
 *
 * El padding-left de la línea 2 alinea el texto bajo el nombre,
 * ignorando el folder icon — patrón hereditario de los selectors
 * de VS Code (Source Control, Run and Debug).
 *
 * Referencia: HANDOFF.md §2.7.
 */

defineProps<{
  project: string;
  task: string;
  branch: string;
}>();
</script>

<template>
  <div class="group-header">
    <!-- === Línea 1: folder icon + project name === -->
    <div class="line-1">
      <i class="codicon codicon-folder" />
      <span class="project">{{ project }}</span>
    </div>
    <!-- === Línea 2: task · branch (mono muted) === -->
    <div class="line-2">{{ task }} · {{ branch }}</div>
  </div>
</template>

<style scoped>
.group-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* === Línea 1 === */
.line-1 {
  display: flex;
  align-items: center;
  gap: 6px;
}
.line-1 .codicon {
  font-size: 12px;
  color: var(--foreground);
}
.project {
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* === Línea 2 === */
.line-2 {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--foreground-muted);
  /* Indent ignorando el folder icon (12px) + gap (6px) = 18px,
   * como dice HANDOFF §2.7. */
  padding-left: 18px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
