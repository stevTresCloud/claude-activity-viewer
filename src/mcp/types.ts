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
