/* ================================================================
 * hook-events.ts — Contrato + validador de los payloads de hook de
 * Claude Code (la señal primaria del viewer).
 *
 * Claude Code dispara un hook por cada evento del ciclo de vida y le
 * pasa un payload JSON por stdin. El forwarder global
 * (resources/hooks/activity-viewer-hook.cjs) lo escribe como NDJSON; el
 * event-source lo lee y se lo pasa a `parseHookEvent`, que lo valida
 * contra el schema y lo entrega tipado al translator.
 *
 * Filosofía del schema (igual que runtime/exit-schema.ts):
 *   - Exigir SOLO los campos que el mapping necesita de verdad; todo
 *     lo accesorio es opcional para no romper ante drift del contrato.
 *   - `.loose()` en cada branch: campos extra del hook (que Claude
 *     Code agregue en versiones futuras) pasan sin rechazo.
 *   - El parser nunca tira: siempre devuelve un ParseHookResult con
 *     una `reason` estable para log + métricas.
 *
 * Referencia del contrato: redesign_viewer/ARCHITECTURE_VIEWER.md §2
 * (validado por spike con CLI 2.1.156).
 * ================================================================ */

import { z } from 'zod';

// === Nombres canónicos de los eventos de hook ===
//
// SSoT compartido: el installer instala el forwarder en EXACTAMENTE
// estos eventos; el parser valida EXACTAMENTE estos. Si se agrega uno
// (ej. PreCompact), entra acá y ambos lados quedan en sync.
export const HOOK_EVENT_NAMES = [
  'SubagentStart',
  'PreToolUse',
  'PostToolUse',
  'SubagentStop',
  'Stop',
  'SessionStart',
  'SessionEnd',
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

// === Schemas por evento ===
//
// Campos comunes a todos (session_id / cwd / transcript_path) se
// declaran por branch como opcionales: en la práctica casi siempre
// vienen, pero no son críticos para el mapping y no queremos que su
// ausencia tumbe un evento útil.

const SubagentStartSchema = z
  .object({
    hook_event_name: z.literal('SubagentStart'),
    // Sin agent_id no hay agente que trackear → es el único campo
    // verdaderamente obligatorio de este evento.
    agent_id: z.string(),
    agent_type: z.string().optional(),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
    transcript_path: z.string().optional(),
  })
  .loose();

const PreToolUseSchema = z
  .object({
    hook_event_name: z.literal('PreToolUse'),
    tool_name: z.string(),
    tool_input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    // agent_id presente solo cuando el PreToolUse proviene de un
    // subagente; el de la sesión principal no lo trae. El translator
    // ignora los que no lo tienen (fuera de scope del viewer en F1).
    agent_id: z.string().optional(),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
  })
  .loose();

const PostToolUseSchema = z
  .object({
    hook_event_name: z.literal('PostToolUse'),
    tool_name: z.string(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    duration_ms: z.number().optional(),
    agent_id: z.string().optional(),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
  })
  .loose();

const SubagentStopSchema = z
  .object({
    hook_event_name: z.literal('SubagentStop'),
    agent_id: z.string(),
    // El resultado que el subagente dejó en su último mensaje. Puede
    // venir null (subagente que terminó sin texto de cierre).
    last_assistant_message: z.string().nullish(),
    agent_transcript_path: z.string().optional(),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
  })
  .loose();

const StopSchema = z
  .object({
    hook_event_name: z.literal('Stop'),
    last_assistant_message: z.string().nullish(),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
  })
  .loose();

const SessionStartSchema = z
  .object({
    hook_event_name: z.literal('SessionStart'),
    session_id: z.string().optional(),
    // Claude Code reporta el origen en `source` (startup/resume/clear).
    source: z.string().optional(),
    cwd: z.string().optional(),
  })
  .loose();

const SessionEndSchema = z
  .object({
    hook_event_name: z.literal('SessionEnd'),
    session_id: z.string().optional(),
    reason: z.string().optional(),
    cwd: z.string().optional(),
  })
  .loose();

/**
 * Union discriminada por `hook_event_name`. TS narrow-a el branch
 * correcto en el `switch` del translator sin casts.
 */
export const HOOK_EVENT_SCHEMA = z.discriminatedUnion('hook_event_name', [
  SubagentStartSchema,
  PreToolUseSchema,
  PostToolUseSchema,
  SubagentStopSchema,
  StopSchema,
  SessionStartSchema,
  SessionEndSchema,
]);

export type HookEvent = z.infer<typeof HOOK_EVENT_SCHEMA>;
export type SubagentStartEvent = z.infer<typeof SubagentStartSchema>;
export type PreToolUseEvent = z.infer<typeof PreToolUseSchema>;
export type PostToolUseEvent = z.infer<typeof PostToolUseSchema>;
export type SubagentStopEvent = z.infer<typeof SubagentStopSchema>;

// === Parser ===

/**
 * Resultado del parser. `reason` es un código estable para log
 * estructurado:
 *   - `not_object`: el JSON parseado no es un objeto (array, string, null).
 *   - `no_event_name`: falta `hook_event_name` o no es string.
 *   - `unknown_event`: `hook_event_name` no está en HOOK_EVENT_NAMES
 *     (ej. PreCompact, UserPromptSubmit — eventos que no instalamos
 *     pero que podrían colarse si el archivo se comparte).
 *   - `schema_violation`: es un evento conocido pero le falta un campo
 *     obligatorio o tiene un tipo incorrecto (ej. SubagentStart sin
 *     agent_id).
 */
export type ParseHookResult =
  | { ok: true; event: HookEvent }
  | {
      ok: false;
      reason: 'not_object' | 'no_event_name' | 'unknown_event' | 'schema_violation';
    };

/**
 * Valida un payload crudo (ya pasado por JSON.parse) contra el
 * contrato de hooks. Chequea el discriminador a mano ANTES de Zod
 * para devolver `unknown_event` con precisión (Zod solo diría
 * "invalid union"). No tira nunca.
 */
export function parseHookEvent(raw: unknown): ParseHookResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'not_object' };
  }

  const name = (raw as Record<string, unknown>).hook_event_name;
  if (typeof name !== 'string') {
    return { ok: false, reason: 'no_event_name' };
  }
  if (!(HOOK_EVENT_NAMES as readonly string[]).includes(name)) {
    return { ok: false, reason: 'unknown_event' };
  }

  const result = HOOK_EVENT_SCHEMA.safeParse(raw);
  if (!result.success) {
    return { ok: false, reason: 'schema_violation' };
  }
  return { ok: true, event: result.data };
}
