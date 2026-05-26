import * as path from 'node:path';
import { z } from 'zod';
import { MODEL_ALIASES, type ModelAlias } from '../runtime/types';

// === Input schema del tool `spawn_agents` ===
//
// El SDK MCP exige el "raw shape" de Zod (objeto plano con campos a Zod
// schemas), NO un `z.object(...)`. El SDK lo envuelve internamente con
// .object() para validar el input del tool. Si pasamos un z.object() acá
// el tipo no compone y el SDK fallaría al inferir el shape.
//
// Campos clave:
//   - `name` opcional (display name kebab-case del agente). Default:
//     `agent-<shortid>` generado por el bridge si falta.
//   - `cwd` obligatorio Y absoluto. Sin cwd no podemos derivar
//     project/task/branch y el dashboard queda con todos los agentes
//     en el mismo "proyecto" (== basename del workspace). Sin
//     `isAbsolute()` el caller podría mandar paths relativos al cwd
//     del extension host — derivación inconsistente. Mejor error
//     claro al caller que un cluster ilegible.
//   - `model` / `priority` opcionales: aceptados forward-compat, no
//     procesados todavía (el bridge ignora estos campos por ahora).
//     Sin `passthrough`, Zod rechazaría unknown keys del caller y
//     rompería integraciones que ya mandan estos extras.
//   - `max(8)` arbitrario, guard contra burst accidentales del
//     chat externo. El bridge soporta N agentes en paralelo (cada
//     `spawn` arranca su propio AgentRunner.startAgent ya que el
//     runner es stateless por call). Subir cuando haga falta.
//   - `options.project` opcional para override de la resolución del
//     project (cuando el cwd está fuera de projectsRoot / workspace
//     y el caller quiere agruparlo bajo un nombre específico).
//   - `options.max_parallel` opcional: aceptado forward-compat.
//     Hoy no se respeta (todas las tasks arrancan a la vez); se
//     usará cuando se cablee queue management.
export const SPAWN_AGENTS_INPUT_SHAPE = {
  tasks: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Display name kebab-case del agente para el dashboard. Default: agent-<shortid>.',
          ),
        prompt: z.string().min(1).describe('Prompt que recibirá el agente.'),
        cwd: z
          .string()
          .min(1)
          .refine((p) => path.isAbsolute(p), {
            message: 'cwd debe ser un path absoluto.',
          })
          .describe(
            'Directorio de trabajo absoluto. Determina project/task/branch del dashboard.',
          ),
        model: z
          .enum(MODEL_ALIASES)
          .optional()
          .describe(
            'Alias del modelo a usar. Default sonnet. El SDK resuelve a id con versión ' +
              '(ej. claude-sonnet-4-5-XXX) y el dashboard muestra la versión real.',
          ),
        priority: z
          .enum(['low', 'med', 'high'])
          .optional()
          .describe('Forward-compat: hoy se ignora; sirve cuando haya queue.'),
      }),
    )
    .min(1)
    .max(8)
    .describe(
      'Lista de tareas a spawnar en paralelo. Cada una corre en su propio subprocess SDK independiente.',
    ),
  options: z
    .object({
      project: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Override del nombre de proyecto para todas las tasks de este call. ' +
            'Si se omite, se deriva del cwd vs claudeOrchestrator.projectsRoot.',
        ),
      max_parallel: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Forward-compat: hoy todas las tasks arrancan a la vez; este límite se respetará cuando haya queue management.',
        ),
    })
    .optional()
    .describe('Opciones globales del batch.'),
} as const;

// Tipo inferido del shape para usarlo en el handler tipado del tool.
// El SDK pasa los argumentos ya validados por Zod; este tipo nos da la
// forma exacta que recibimos en el callback.
export type SpawnAgentsArgs = {
  tasks: Array<{
    name?: string;
    prompt: string;
    cwd: string;
    model?: ModelAlias;
    priority?: 'low' | 'med' | 'high';
  }>;
  options?: { project?: string; max_parallel?: number };
};

// === Input schema del tool `list_agents` ===
//
// Sin argumentos. El SDK MCP igual exige el raw shape como objeto;
// un object vacío indica "tool sin params".
export const LIST_AGENTS_INPUT_SHAPE = {} as const;

export type ListAgentsArgs = Record<string, never>;

// === Input schema del tool `get_agent_log` ===
//
// `agent_id`: requerido. UUID retornado por spawn_agents.
// `since`: opcional. Epoch ms; filtra entries con `ts > since` para
//    paginación incremental. Sin `since`, devuelve todo el
//    ringbuffer (cap 1000 del bridge).
export const GET_AGENT_LOG_INPUT_SHAPE = {
  agent_id: z
    .string()
    .min(1)
    .describe('Id del agente devuelto por spawn_agents (UUID).'),
  since: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Filtrar entries del log con ts > since (epoch ms). Útil para paginar incrementalmente: ' +
        'el cliente guarda el ts del último entry recibido y pide el delta en la próxima call.',
    ),
} as const;

export type GetAgentLogArgs = {
  agent_id: string;
  since?: number;
};

// === Input schema del tool `cancel_agent` ===
//
// `agent_id`: requerido. UUID retornado por spawn_agents.
//
// Diseño: wrapper trivial de `bridge.cancel(agentId)`. El bridge
// retorna `boolean` (true = había un AbortController vivo y se
// disparó; false = no existe o ya terminó). Para el caller MCP
// ese `false` NO es error operacional — es estado legítimo "el
// agente ya estaba muerto", así que respondemos `{cancelled: false}`
// sin `isError`. Errores reales del bridge (excepciones) sí
// emergen como `isError: true`.
export const CANCEL_AGENT_INPUT_SHAPE = {
  agent_id: z
    .string()
    .min(1)
    .describe('Id del agente devuelto por spawn_agents (UUID).'),
} as const;

export type CancelAgentArgs = {
  agent_id: string;
};
