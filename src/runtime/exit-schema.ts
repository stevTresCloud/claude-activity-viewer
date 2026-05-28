/* ================================================================
 * exit-schema.ts — Schema + parser + prompts del Mecanismo D + A.
 *
 * Helpers puros (sin dependencias VS Code / runtime / bridge) que
 * centralizan:
 *   1. La forma del exit report estructurado que el agente debe
 *      devolver en su último text block (Mecanismo D).
 *   2. El parser tolerante que extrae el JSON de prosa libre y lo
 *      valida con Zod.
 *   3. El briefing que el bridge concatena al prompt del agente
 *      cuando `verification ≠ 'none'`.
 *   4. El prompt fijo del critic Haiku (Mecanismo A).
 *
 * Por qué archivo aparte:
 *   - Es 100% puro: el bridge lo importa, los tests lo importan
 *     sin levantar nada. Sin esto, los tests del bridge tendrían
 *     que mockear briefings inline.
 *   - El briefing del agente es texto grande (~700 chars). Tenerlo
 *     fuera del bridge.ts evita inflar ese archivo y mantiene el
 *     contrato D documentado en un solo lugar.
 *
 * Referencia: research/VERIFICATION_MECHANISMS.md §3-D, §3-A.
 * ================================================================ */

import { z } from 'zod';

// === Schema del exit report (Mecanismo D) ===

/**
 * Forma del JSON que el agente debe emitir al final de su último
 * text block cuando `verification ≠ 'none'`. Es la versión 1 del
 * schema; si en el futuro se extiende, se versiona como ExitSchemaV2
 * y el parser intenta v2 primero, fallback a v1.
 *
 * `default([])` en los array fields: el agente puede omitirlos si
 * están vacíos sin que el parse falle. Zod los rellena con `[]`
 * post-validación. NO se aplica a `status` que es obligatorio.
 *
 * `passthrough()`: el agente puede agregar campos extra (ej. `notes`,
 * `next_steps`) sin que el schema los rechace. Forward-compat barato.
 */
export const EXIT_SCHEMA_V1 = z
  .object({
    status: z.enum(['ok', 'needs_review', 'failed']),
    files_changed: z.array(z.string()).default([]),
    evidence_run: z.array(z.string()).default([]),
    decisions_made_without_consultation: z.array(z.string()).default([]),
    uncertainties: z.array(z.string()).default([]),
  })
  .passthrough();

export type ExitReport = z.infer<typeof EXIT_SCHEMA_V1>;

// === Parser ===

/**
 * Resultado del parser. Variantes:
 *   - `{ok: true, parsed}`: el JSON fue extraído y validó contra el schema.
 *   - `{ok: false, raw?, reason}`: alguna etapa falló. `reason` es código
 *     estable para métricas + log estructurado (§8 del doc); `raw` queda
 *     cuando hubo un candidato JSON que NO validó (para debugging).
 *
 * Códigos de `reason`:
 *   - `'no_input'`: el text era null/empty.
 *   - `'no_json_block'`: el text no contenía ningún bloque JSON.
 *   - `'invalid_json'`: el bloque candidato no parseó con JSON.parse.
 *   - `'schema_violation'`: parseó pero falló el schema Zod (campos
 *     ausentes, tipos incorrectos).
 */
export type ParseExitResult =
  | { ok: true; parsed: ExitReport }
  | { ok: false; reason: 'no_input' | 'no_json_block' | 'invalid_json' | 'schema_violation'; raw?: string };

/**
 * Tamaño máximo del texto que aceptamos parsear. Defensivo contra
 * agentes que devuelvan un text block patológicamente grande (multi-MB).
 * 2 MB cubre logs de agentes verbosos con margen. Truncamos al final
 * (preserva el JSON que va a ese extremo).
 */
const MAX_PARSE_INPUT_BYTES = 2 * 1024 * 1024;

/**
 * Busca un bloque JSON en `text` y lo valida contra EXIT_SCHEMA_V1.
 *
 * Estrategia de extracción (en orden):
 *   1. Último ```json ... ``` (case-insensitive en el tag).
 *   2. Último ``` ... ``` no marcado que parsee como objeto.
 *   3. Último `{ ... }` balanceado del text (best-effort).
 *
 * El "último" es deliberado: el agente puede haber emitido JSONs
 * intermedios en código de ejemplo durante el turno; lo que cuenta
 * es el bloque final que cierra el reporte.
 *
 * No tira en ninguna rama — siempre retorna un ParseExitResult.
 */
export function parseExitSchema(text: string | null | undefined): ParseExitResult {
  if (!text || text.length === 0) {
    return { ok: false, reason: 'no_input' };
  }

  // Truncate desde el INICIO para conservar el final del text, que es
  // donde vive el JSON por convención. Truncar del final perdería el
  // bloque que queremos parsear.
  const truncated =
    text.length > MAX_PARSE_INPUT_BYTES
      ? text.slice(text.length - MAX_PARSE_INPUT_BYTES)
      : text;

  const candidate = extractJsonCandidate(truncated);
  if (candidate === null) {
    return { ok: false, reason: 'no_json_block' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: 'invalid_json', raw: candidate };
  }

  const result = EXIT_SCHEMA_V1.safeParse(parsedJson);
  if (!result.success) {
    return { ok: false, reason: 'schema_violation', raw: candidate };
  }
  return { ok: true, parsed: result.data };
}

/**
 * Extrae el candidato JSON más probable del text. Devuelve el string
 * crudo (no parseado) para que `parseExitSchema` reporte `invalid_json`
 * vs `schema_violation` por separado.
 */
function extractJsonCandidate(text: string): string | null {
  // 1. Fenced ```json — más confiable. Tomamos el ÚLTIMO match porque
  //    el agente puede haber mostrado ejemplos antes.
  const jsonFenceRegex = /```json\s*([\s\S]*?)```/gi;
  const jsonFenceMatches = [...text.matchAll(jsonFenceRegex)];
  if (jsonFenceMatches.length > 0) {
    const last = jsonFenceMatches[jsonFenceMatches.length - 1];
    return last[1].trim();
  }

  // 2. Fenced ``` sin lenguaje. Cualquier bloque cuyo contenido empiece
  //    con `{` y termine con `}` puede ser nuestro candidato. Usamos el
  //    último que cumple esa heurística.
  const anyFenceRegex = /```[\w]*\s*([\s\S]*?)```/g;
  const anyFenceMatches = [...text.matchAll(anyFenceRegex)];
  for (let i = anyFenceMatches.length - 1; i >= 0; i--) {
    const inner = anyFenceMatches[i][1].trim();
    if (inner.startsWith('{') && inner.endsWith('}')) {
      return inner;
    }
  }

  // 3. Last-resort: buscar el último `{ ... }` balanceado del text.
  //    No es perfecto (un string con `}` dentro puede romper la cuenta)
  //    pero cubre el caso en que el agente olvida los backticks pero sí
  //    devuelve un JSON limpio. parseJsonObjectFromEnd retorna null si
  //    no encuentra balance.
  return parseLastBalancedObject(text);
}

/**
 * Recorre el text de atrás hacia adelante buscando el último `{ ... }`
 * balanceado a nivel de braces (cuenta `{` y `}` ignorando los que están
 * dentro de strings JSON). Pragmatic — no es un parser completo:
 *   - Reconoce escapes `\"` dentro de strings.
 *   - No reconoce comentarios (JSON no los permite, así que es OK).
 *   - Si el text tiene varios objetos al hilo, devuelve el último.
 *
 * Devuelve null si no encuentra ningún objeto balanceado.
 */
function parseLastBalancedObject(text: string): string | null {
  // Buscar la última `}` que cierre un objeto balanceado yendo desde
  // su posición hacia atrás contando braces.
  const lastClose = text.lastIndexOf('}');
  if (lastClose === -1) return null;

  let depth = 0;
  let inString = false;
  for (let i = lastClose; i >= 0; i--) {
    const ch = text[i];
    // Tracking de strings: una `"` no escapada flippea el estado.
    if (ch === '"') {
      // Contar backslashes previos para detectar escape.
      let backslashes = 0;
      let j = i - 1;
      while (j >= 0 && text[j] === '\\') {
        backslashes++;
        j--;
      }
      if (backslashes % 2 === 0) inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) {
        return text.slice(i, lastClose + 1);
      }
    }
  }
  return null;
}

// === Briefing del agente (Mecanismo D) ===

/**
 * Devuelve el bloque de instrucción que el bridge concatena al final
 * del prompt del agente. Lleva el contrato D explícito + ejemplo + las
 * 4 reglas anti-mentira que motivan el uso de `decisions_made_without_consultation`.
 *
 * Es un string fijo (no params por ahora). Si en v0.3 entran knobs
 * per-batch, se parametriza.
 */
export function buildExitSchemaInstruction(): string {
  return `

---

## Exit report (mandatory)

Before ending your turn, emit a fenced JSON block at the end of your final assistant message with the following shape:

\`\`\`json
{
  "status": "ok",
  "files_changed": ["path/a.py"],
  "evidence_run": ["ast.parse OK on a.py", "grep -c 'X' returned 2"],
  "decisions_made_without_consultation": [],
  "uncertainties": []
}
\`\`\`

Rules (read carefully — these decide whether the orchestrator promotes your status to \`needs_review\`):

1. **If you made ANY decision the briefing did not explicitly authorize**, it MUST appear in \`decisions_made_without_consultation\`. Examples:
   - Replaced a test instead of adding one.
   - Flipped an assertion direction (\`assertTrue → assertFalse\`, \`== → !=\`).
   - Renamed a function used by other files without updating call sites.
   - Removed error handling, validation, or a guard you thought was redundant.
   - Copied code from another version/branch and applied it without validating against the current schema/API.
   Self-rationalizing the decision as "obviously correct" does not exempt you. The whole point of this field is to surface decisions the orchestrator can audit.

2. **If you copied code without validating it against the current code/schema/API**, that is an uncertainty. List it.

3. A \`"status": "ok"\` with a non-empty \`decisions_made_without_consultation\` or \`uncertainties\` is contradictory. The orchestrator will auto-promote you to \`needs_review\` anyway. Honest \`needs_review\` is preferred over silent \`ok\`.

4. This JSON block must be the LAST thing you emit. Code examples or other JSON before it are fine.
`;
}

// === Critic prompt (Mecanismo A) ===

/**
 * Tamaño máximo del diff que enviamos al critic. 500 KB es generoso
 * para la mayoría de batches; si el agente generó cambios más grandes,
 * truncamos y el critic recibe un aviso explícito en el prompt.
 */
export const CRITIC_DIFF_MAX_BYTES = 500 * 1024;

/**
 * Tools que el critic Haiku puede usar. Allow-list explícita en lugar
 * del preset `claude_code` — el critic NO debe escribir ni editar
 * código. Bash queda permitido porque el critic puede querer correr
 * `git log`, `grep`, etc., pero el briefing le exige no usarlo para
 * modificar archivos. El sandbox real es el prompt + el smoke E2E
 * que valida ausencia de tool_use de tipo Write/Edit.
 */
export const CRITIC_TOOL_ALLOWLIST: string[] = ['Read', 'Bash', 'Grep', 'Glob'];

/**
 * Entrada para el critic. `name` y `subtitle` orientan al critic sobre
 * la tarea original; el resto es el material que tiene que evaluar.
 */
export interface CriticInput {
  agentName: string;
  /** Subtitle del agente (último tool input legible). Opcional. */
  agentSubtitle?: string;
  /** Reporte estructurado del agente. Si parse falló, queda undefined. */
  exitReport?: ExitReport;
  /** Diff git `headBefore..HEAD` ya truncado a CRITIC_DIFF_MAX_BYTES. */
  diff: string;
  /** True si el diff fue truncado — el prompt lo flaggea al critic. */
  diffTruncated: boolean;
}

/**
 * Output esperado del critic (lo emite en su último text block como
 * JSON). Mismo patrón que ExitReport: parseamos vía `parseCriticOutput`.
 */
export interface CriticFinding {
  file?: string;
  line?: number;
  severity: 'high' | 'med' | 'low';
  summary: string;
}

export interface CriticOutput {
  flags: CriticFinding[];
  summary: string;
}

const CRITIC_OUTPUT_SCHEMA = z
  .object({
    flags: z
      .array(
        z
          .object({
            file: z.string().optional(),
            line: z.number().int().nonnegative().optional(),
            severity: z.enum(['high', 'med', 'low']),
            summary: z.string().min(1),
          })
          .passthrough(),
      )
      .default([]),
    summary: z.string().default(''),
  })
  .passthrough();

/**
 * Construye el prompt del critic Haiku. Texto fijo (excepto la
 * inyección del diff + reportes del agente). Refleja §3-A del doc:
 * "FLAGS only, NO propongas fixes" + reminder "no participaste de
 * los cambios".
 */
export function buildCriticPrompt(input: CriticInput): string {
  const exitReportBlock = input.exitReport
    ? JSON.stringify(input.exitReport, null, 2)
    : '(agent did not produce a parseable exit report)';

  const diffSection = input.diffTruncated
    ? `${input.diff}\n\n--- diff truncated at ${CRITIC_DIFF_MAX_BYTES} bytes ---`
    : input.diff;

  return `You are a verification critic spawned by the claude-orchestrator after another sub-agent completed its work. You did NOT participate in the changes. Your job is to FLAG concerns in the diff — do NOT propose fixes, do NOT modify any file.

## Context

- Agent name: ${input.agentName}
- Agent subtitle (last task focus): ${input.agentSubtitle ?? '(unknown)'}

## Agent's self-reported exit report

\`\`\`json
${exitReportBlock}
\`\`\`

## Diff produced by the agent (git diff headBefore..HEAD)

\`\`\`diff
${diffSection}
\`\`\`

## Your task

Compare the diff against the agent's self-report and the briefing pattern. Flag concerns ONLY when something the agent did is genuinely concerning. Examples of what TO flag:

- **Assertion contract flips**: \`assertTrue → assertFalse\`, \`== → !=\`, mock expectation inverted, return value of a guard flipped — when the agent did NOT declare it in \`decisions_made_without_consultation\`.
- **SQL referencing columns the agent did not validate against the current schema** (e.g. copied from a previous version without checking).
- **Tests REPLACED rather than added** when the diff is in test files and the agent's \`evidence_run\` does not mention re-validating the original contract.
- **Function or method renames** without updates to the call sites in the same diff.
- **Silent removal of error handling, validation, guards, or default values** without justification in the exit report.
- **New external dependencies, network calls, or shell commands** that are surprising for the task.
- **Behavioral changes the agent did not declare** in \`decisions_made_without_consultation\` that a PR reviewer would push back on.

## What NOT to flag

Default to NO flags when the diff is small, additive, and does not change existing code paths. The following do NOT warrant flags:

- **Adding a helper function, constant, or import** that is not yet wired up. The agent may wire it next iteration; missing integration is the next task, not a bug.
- **Empty \`evidence_run\` for purely additive changes** (new helper, new constant, comment, docstring, type annotation, whitespace, formatting). Only flag empty \`evidence_run\` when the agent CHANGED EXISTING BEHAVIOR (modified logic, flipped assertions, touched tests, removed lines) without validating.
- **Style choices, naming preferences, or "could be more idiomatic" suggestions**. You are a safety net for correctness, not a style reviewer.
- **Speculative future risks** ("this MIGHT cause X later", "no integration strategy documented"). Only flag concrete current issues that exist in the diff right now.
- **Trivial cosmetic changes** (typos in comments, reformatting, reordering imports without removal).

When in doubt, prefer NO flag. The orchestrator already auto-promotes when the agent self-reports decisions or uncertainties via the structured exit (Mechanism D). Your role (Mechanism A) is to catch what the agent OMITTED — silent contract changes, hidden side effects, copy-paste bugs — NOT to second-guess every benign addition.

If the diff is empty or the agent reported nothing changed, return \`{"flags": [], "summary": "no diff"}\`.

## Constraints

- You MUST NOT use Write, Edit, or any tool that modifies files. Allowed tools: Read, Bash (read-only commands like git log/grep/cat — do NOT redirect output to files), Grep, Glob.
- You may invoke \`Read\` on any file in the agent's cwd to validate concerns against the current code.
- Do NOT use Bash to run tests, install packages, or anything with side effects beyond reading.

## Output (mandatory — last thing you emit)

Emit a fenced JSON block at the end of your final message with this shape:

\`\`\`json
{
  "flags": [
    { "file": "path/relative/to/cwd", "line": 42, "severity": "high", "summary": "assertion contract flipped without justification" }
  ],
  "summary": "1-2 sentence overall verdict"
}
\`\`\`

If you find nothing: \`{"flags": [], "summary": "no concerns"}\`.

\`severity\` is one of \`"high"\` (likely incorrect), \`"med"\` (suspicious, deserves review), \`"low"\` (style/minor).
`;
}

/**
 * Parser del output del critic. Misma estrategia que `parseExitSchema`:
 * busca un fenced ```json al final del text, parsea, valida.
 *
 * Si el critic no devolvió output válido, retornamos un flag artificial
 * `severity: 'low'` indicando la falla del parser — preferible a perder
 * el critic completo en silencio.
 */
export function parseCriticOutput(text: string | null | undefined): CriticOutput {
  if (!text || text.length === 0) {
    return {
      flags: [{ severity: 'low', summary: 'critic produced no output' }],
      summary: 'critic_no_output',
    };
  }

  const candidate = extractJsonCandidate(text);
  if (candidate === null) {
    return {
      flags: [{ severity: 'low', summary: 'critic output missing JSON block' }],
      summary: 'critic_no_json_block',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return {
      flags: [{ severity: 'low', summary: 'critic JSON block did not parse' }],
      summary: 'critic_invalid_json',
    };
  }

  const result = CRITIC_OUTPUT_SCHEMA.safeParse(parsed);
  if (!result.success) {
    return {
      flags: [{ severity: 'low', summary: 'critic output violated schema' }],
      summary: 'critic_schema_violation',
    };
  }
  return result.data;
}
