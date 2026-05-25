import { z } from 'zod';

// === Input schema del tool `spawn_agents` ===
// El SDK MCP exige el "raw shape" de Zod (objeto plano con campos a Zod
// schemas), NO un `z.object(...)`. El SDK lo envuelve internamente con
// .object() para validar el input del tool. Si pasamos un z.object() acá
// el tipo no compone y el SDK fallaría al inferir el shape.
//
// max(1) actual: el handler procesa UNA task sincrónicamente y devuelve su
// AgentResult. Esa simplificación es deliberada — el contrato "spawn N en
// paralelo y devolver agentIds" del diseño completo requiere coordinación
// async + persistencia, que se va a sumar más adelante. Hacemos el límite
// explícito para que el cliente externo (chat Claude Code) vea el error de
// validación claro en vez de "tu segunda task se ignoró silenciosamente".
export const SPAWN_AGENTS_INPUT_SHAPE = {
  tasks: z
    .array(
      z.object({
        prompt: z.string().min(1).describe('Prompt que recibirá el agente.'),
        cwd: z
          .string()
          .optional()
          .describe(
            'Directorio de trabajo. Default: primer workspace folder de la EDH.',
          ),
      }),
    )
    .min(1)
    .max(1)
    .describe(
      'Lista de tareas a spawnar. Por ahora exactamente 1; se ampliará cuando se soporte ejecución en paralelo.',
    ),
} as const;

// Tipo inferido del shape para usarlo en el handler tipado del tool.
// El SDK pasa los argumentos ya validados por Zod; este tipo nos da la
// forma exacta que recibimos en el callback.
export type SpawnAgentsArgs = {
  tasks: Array<{ prompt: string; cwd?: string }>;
};
