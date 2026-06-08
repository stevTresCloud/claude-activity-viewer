#!/usr/bin/env node
'use strict';

/* ================================================================
 * activity-viewer-hook.cjs — Forwarder global de hooks de Claude Code.
 *
 * Lo instala `hook-installer.ts` como comando de los hooks globales
 * del usuario (~/.claude/settings.json). Claude Code lo invoca por
 * cada evento (SubagentStart, PreToolUse, ...) pasándole el payload
 * JSON por stdin. El script lo escribe como UNA línea NDJSON en un
 * archivo spool que la extensión tail-ea.
 *
 * Precedente directo: el usuario ya corre un forwarder análogo de
 * pixel-agents (~/.pixel-agents/hooks/claude-hook.js). Los hooks se
 * SUMAN por evento, no chocan.
 *
 * Por qué archivo + append (no socket):
 *   - Cero servidor: sobrevive reinicios y no pelea por un puerto.
 *   - Multi-window natural: cada ventana de VS Code tail-ea el mismo
 *     archivo de forma independiente (el socket de puerto fijo solo
 *     deja ver a una ventana — bug heredado del MCP server).
 *
 * Por qué CJS standalone sin deps:
 *   El hook corre como `node "<path>"` en un proceso efímero fuera
 *   del bundle de la extensión; no puede importar nada del out/.
 *
 * El path del spool lo pasa el installer como argv[2] (única fuente
 * de verdad, en TS); el fallback al homedir cubre la invocación
 * standalone (tests / smoke manual).
 *
 * Invariante crítico: un hook NUNCA debe romper al agente. Todo error
 * (stdin ilegible, JSON inválido, disco lleno) se traga y sale 0.
 * ================================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS_FILE =
  process.argv[2] ||
  path.join(os.homedir(), '.claude', 'claude-activity-viewer', 'events.jsonl');

// Umbral del tamaño de línea: por debajo serializamos una sola vez (el
// caso común). Por encima, acotamos los campos pesados (tool_input de
// un Write grande, tool_response de un Read largo) y re-serializamos.
// Mantener cada línea chica preserva la atomicidad del append en ext4
// aunque varios agentes escriban en paralelo. El detalle pesado NO se
// pierde: se reconstruye bajo demanda desde transcript_path.
const MAX_LINE_CHARS = 3000;
const MAX_FIELD_CHARS = 2000;

function boundLargeFields(data) {
  if (!data || typeof data !== 'object') return data;
  const clone = { ...data };
  for (const key of ['tool_input', 'tool_response']) {
    const value = clone[key];
    if (value === undefined) continue;
    const serialized = typeof value === 'string' ? value : safeStringify(value);
    if (serialized !== null && serialized.length > MAX_FIELD_CHARS) {
      clone[key] = serialized.slice(0, MAX_FIELD_CHARS) + '…[truncated]';
    }
  }
  return clone;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function appendLine(line) {
  try {
    // Un solo appendFileSync = un solo write() en el path feliz, lo que
    // en ext4 local es efectivamente atómico para líneas de este tamaño.
    fs.appendFileSync(EVENTS_FILE, line + '\n');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Primer evento: el dir del spool aún no existe. Lo creamos y
      // reintentamos una vez (evita el mkdirSync proactivo en cada hook).
      try {
        fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
        fs.appendFileSync(EVENTS_FILE, line + '\n');
      } catch {
        // Tragamos: el viewer es best-effort.
      }
    }
    // Otros errores (permisos, disco lleno): tragamos. Un hook no debe
    // abortar al agente.
  }
}

async function main() {
  // Acumulamos los Buffers de stdin y decodificamos UNA vez al final:
  // `input += chunk` decodificaría cada chunk por separado y rompería un
  // char UTF-8 multibyte partido en el borde entre dos chunks.
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);

  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return; // payload ilegible → no hay nada que reenviar
  }

  // Serializa una sola vez en el caso común; solo si la línea excede el
  // umbral pagamos el acotado + re-serialización (eventos raros con un
  // tool_response gigante).
  let line = safeStringify(data);
  if (line === null) return;
  if (line.length > MAX_LINE_CHARS) {
    line = safeStringify(boundLargeFields(data));
    if (line === null) return;
  }

  appendLine(line);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
