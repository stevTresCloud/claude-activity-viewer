/* ================================================================
 * transcript-reader.ts — Extrae métricas del `.jsonl` de un agente.
 *
 * Los hooks de Claude Code NO reportan tokens / modelo / context%
 * (ver translator.ts: los deja en 0/undefined). Esos datos sí viven
 * en el transcript `.jsonl` del agente: cada evento `type:"assistant"`
 * trae `message.model` + `message.usage`. Este módulo lo lee on-demand
 * cuando el detail panel se monta y deriva las métricas para el header.
 *
 * Por qué confinado acá:
 *   El schema del `.jsonl` es PRIVADO de Claude Code (no es contrato
 *   público) y puede cambiar entre versiones. Todo el riesgo de parseo
 *   queda en este archivo: `readTranscriptMetrics` envuelve TODO en un
 *   try/catch que degrada a `{}`. Aguas arriba (bridge/webview) un `{}`
 *   significa "sin dato" y la UI esconde ContextBar/ModelBadge — el
 *   viewer nunca rompe por un transcript inesperado.
 *
 * Estrategia de lectura (patrón tolerante de session-scanner):
 *   - Stream line-by-line (no readFileSync: los `.jsonl` pueden traer
 *     base64 de screenshots y crecer a varios MB).
 *   - Cada línea se parsea aislada; una malformada se saltea, no tumba
 *     el resto (file truncado a mitad → última línea parcial ignorada).
 *   - Gana el ÚLTIMO evento assistant con `message.model`: refleja el
 *     estado más reciente del context window. A diferencia del
 *     session-scanner (que corta a 256KB porque escanea 100+ archivos
 *     y solo necesita el header), acá leemos el archivo entero: nos
 *     interesa la COLA, es UNA sola lectura on-demand, y un corte
 *     temprano nos haría perder justamente el dato que buscamos. Si en
 *     uso real aparecen transcripts multi-MB, conviene leer por tail
 *     (fs.stat + createReadStream({ start })) en vez del full-read.
 *
 * Fuera de scope v0.3: re-lectura periódica en vivo del transcript
 * (las métricas se congelan al momento de abrir el panel).
 * ================================================================ */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { AgentMetrics } from '../shared/dashboard-protocol';

// === Constantes ===

/**
 * Context window por defecto de los modelos Claude actuales
 * (Opus/Sonnet/Haiku 4.x). El denominador de `contextUsedPct`.
 */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Context window del beta de 1M tokens, señalado por el sufijo `[1m]`. */
const ONE_MILLION_CONTEXT_WINDOW = 1_000_000;

// === Tipos ===

// Las métricas derivadas reusan `AgentMetrics` del protocolo (un subset
// de `AgentSnapshot`): un solo origen de los nombres de campo evita drift
// con el `Object.assign` que las mergea en el store. Todos opcionales: un
// transcript sin assistant devuelve `{}`, uno sin `usage` solo `{ model }`,
// y la UI gatea cada métrica por su cuenta (`v-if`).

/** Subset del evento assistant que nos interesa del `.jsonl`. */
interface AssistantLine {
  type?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

// ====================================================================
// === API pública ====================================================
// ====================================================================

/**
 * Lee el transcript del agente y devuelve sus métricas. NUNCA tira:
 * cualquier fallo (archivo inexistente, sin permisos, schema raro,
 * stream roto) degrada a `{}`. El path inválido/vacío también → `{}`.
 */
export async function readTranscriptMetrics(
  filePath: string | undefined,
): Promise<AgentMetrics> {
  if (!filePath) return {};
  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    return await extractMetrics(rl);
  } catch {
    return {};
  }
}

/**
 * Núcleo puro: recorre líneas (sync o async iterable), se queda con el
 * último evento assistant que trae `message.model` y deriva las
 * métricas. Exportada para testear sin tocar disco.
 *
 * Tolerante: una línea no-JSON se saltea. Si ninguna línea es un
 * assistant con modelo, devuelve `{}`.
 */
export async function extractMetrics(
  lines: Iterable<string> | AsyncIterable<string>,
): Promise<AgentMetrics> {
  let lastAssistant: AssistantLine | null = null;

  for await (const raw of lines as AsyncIterable<string>) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: AssistantLine;
    try {
      parsed = JSON.parse(line) as AssistantLine;
    } catch {
      continue;
    }
    // El modelo es la señal mínima: sin él no hay nada que reportar de
    // este evento. El último assistant con modelo gana (estado más
    // reciente del context).
    if (parsed?.type === 'assistant' && parsed.message?.model) {
      lastAssistant = parsed;
    }
  }

  if (!lastAssistant?.message?.model) return {};

  const metrics: AgentMetrics = {
    model: prettifyModel(lastAssistant.message.model),
  };

  // `usage` puede faltar (assistant sin turno completo): en ese caso
  // reportamos solo el modelo y la UI esconde ContextBar + chip tokens.
  const usage = lastAssistant.message.usage;
  if (usage) {
    const contextTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    const window = contextWindowFor(lastAssistant.message.model);
    metrics.contextTokens = contextTokens;
    metrics.contextUsedPct = Math.round((contextTokens / window) * 100);
    metrics.tokensUsed = usage.output_tokens ?? 0;
  }

  return metrics;
}

// ====================================================================
// === Helpers de modelo (puros, testeables) ==========================
// ====================================================================

/**
 * Context window del modelo. El beta de 1M tokens se marca con el
 * sufijo `[1m]` en el id (ej. `claude-opus-4-8[1m]`); el resto usa el
 * default de 200k.
 */
export function contextWindowFor(rawModel: string): number {
  return /\[1m\]/i.test(rawModel)
    ? ONE_MILLION_CONTEXT_WINDOW
    : DEFAULT_CONTEXT_WINDOW;
}

/**
 * Convierte el id crudo del SDK en un display string amigable:
 *   - `claude-opus-4-8`            → "Opus 4.8"
 *   - `claude-opus-4-8[1m]`        → "Opus 4.8 (1M)"
 *   - `claude-sonnet-4-6`          → "Sonnet 4.6"
 *   - `claude-3-5-haiku-20241022`  → "Haiku 3.5"
 *
 * Best-effort: si no reconoce la familia (opus/sonnet/haiku), devuelve
 * el id crudo tal cual — preferimos algo honesto a esconder el dato.
 */
export function prettifyModel(rawModel: string): string {
  const oneMillion = /\[1m\]/i.test(rawModel);
  const cleaned = rawModel
    .replace(/\[1m\]/i, '')
    .replace(/^claude-/i, '')
    .replace(/-\d{8}$/, ''); // fecha trailing (ej. -20241022)

  const tokens = cleaned.split('-').filter(Boolean);
  const family = tokens.find((t) => /^(opus|sonnet|haiku)$/i.test(t));
  if (!family) return rawModel;

  const numbers = tokens.filter((t) => /^\d+$/.test(t));
  const version =
    numbers.length >= 2 ? `${numbers[0]}.${numbers[1]}` : numbers[0] ?? '';

  const name = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase();
  const base = version ? `${name} ${version}` : name;
  return oneMillion ? `${base} (1M)` : base;
}
