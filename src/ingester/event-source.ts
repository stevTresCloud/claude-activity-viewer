/* ================================================================
 * event-source.ts — Transporte hook → extensión (NDJSON + tail).
 *
 * El forwarder global escribe un evento por línea en un archivo spool
 * (~/.claude/claude-orchestrator/events.jsonl). Esta clase lo tail-ea:
 * trackea el offset leído, lee solo lo nuevo en cada cambio, parsea
 * línea a línea y emite el JSON crudo de cada evento válido.
 *
 * Por qué archivo en vez de socket (decisión §5.1 del plan):
 *   - Multi-window natural: N ventanas de VS Code tail-ean el mismo
 *     archivo a la vez. Un socket de puerto fijo solo deja ver a una.
 *   - Cero servidor: sobrevive reinicios, no hay puerto que liberar.
 *
 * Robustez:
 *   - Líneas parciales (append cortado a mitad) se retienen en buffer
 *     hasta que llega el `\n`.
 *   - Líneas corruptas (JSON inválido) se saltan y se cuentan, no
 *     tumban el tail.
 *   - Truncado/rotación (size < offset) → reset a 0 y re-lee.
 *   - fs.watch es best-effort (puede perder eventos bajo carga o tras
 *     rotación); un poll de baja frecuencia es el backbone confiable.
 *
 * La lectura vive en `drain()` (público) para testear el tail sin
 * depender de timers ni del scheduler del SO.
 * ================================================================ */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Fuente de eventos de hook. Abstracción detrás de la cual el
 * transporte concreto (archivo hoy, socket si hiciera falta) es
 * intercambiable sin tocar el translator ni la fachada.
 */
export interface HookEventSource {
  /** Registra un consumidor del JSON crudo de cada evento. Devuelve unsubscribe. */
  onEvent(cb: (raw: unknown) => void): () => void;
  /** Empieza a observar la fuente. */
  start(): void;
  /** Libera watchers/timers. */
  dispose(): void;
}

const DEFAULT_POLL_MS = 1000;

export interface JsonlEventSourceOptions {
  filePath: string;
  /** Intervalo del poll de respaldo (ms). 0 desactiva el poll (solo watch). */
  pollMs?: number;
  /** Sink opcional para diagnosticar líneas corruptas. */
  log?: (msg: string) => void;
}

export class JsonlEventSource implements HookEventSource {
  private readonly filePath: string;
  private readonly pollMs: number;
  private readonly log?: (msg: string) => void;
  private readonly listeners = new Set<(raw: unknown) => void>();

  private offset = 0;
  // Acumulador en BYTES (no string): partir en líneas a nivel de bytes y
  // decodificar solo líneas completas evita romper un carácter UTF-8
  // multibyte (p.ej. el '…' que el forwarder inserta al truncar) cuando
  // cae justo en el borde de una lectura.
  private pending: Buffer = Buffer.alloc(0);
  private skipped = 0;

  private watcher?: fs.FSWatcher;
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(opts: JsonlEventSourceOptions) {
    this.filePath = opts.filePath;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.log = opts.log;
  }

  onEvent(cb: (raw: unknown) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    this.ensureFile();
    // Arrancamos desde el FINAL del archivo: no queremos re-emitir
    // eventos viejos (agentes ya terminados) en cada arranque. Los
    // agentes que sigan vivos se materializan vía lazy-create cuando
    // llegue su próximo evento.
    try {
      this.offset = fs.statSync(this.filePath).size;
    } catch {
      this.offset = 0;
    }

    try {
      this.watcher = fs.watch(this.filePath, () => this.drain());
    } catch {
      // fs.watch puede fallar (FS sin inotify, archivo en red). El poll
      // cubre el caso; no es fatal.
    }

    if (this.pollMs > 0) {
      this.pollTimer = setInterval(() => this.drain(), this.pollMs);
      // No mantener vivo el event loop solo por el poll del tail.
      this.pollTimer.unref?.();
    }
  }

  /**
   * Lee lo nuevo del archivo desde `offset`, parsea las líneas
   * completas y emite cada evento. Público para que los tests
   * ejerzan el tail de forma determinística (append + drain + assert)
   * sin esperar timers.
   */
  drain(): void {
    let size: number;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      // Archivo ausente (rotado/borrado). Reseteamos para re-leer desde
      // 0 cuando el forwarder lo recree.
      this.reset();
      return;
    }

    // Truncado o rotación: el archivo encogió respecto a lo ya leído.
    if (size < this.offset) this.reset();
    if (size <= this.offset) return;

    const chunk = this.readFrom(this.offset, size);
    if (chunk.length === 0) return;

    this.pending = this.pending.length
      ? Buffer.concat([this.pending, chunk])
      : chunk;

    // Parte en líneas completas (newline = 0x0A); los bytes posteriores
    // al último `\n` quedan en `pending` hasta que el próximo append los
    // complete (line parcial o char multibyte a medias).
    let nl: number;
    while ((nl = this.pending.indexOf(0x0a)) !== -1) {
      const line = this.pending.subarray(0, nl).toString('utf8').trim();
      this.pending = this.pending.subarray(nl + 1);
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.skipped++;
        this.log?.(`[ingester] skipped corrupt line (#${this.skipped})`);
        continue;
      }
      this.emit(parsed);
    }
  }

  private reset(): void {
    this.offset = 0;
    this.pending = Buffer.alloc(0);
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.listeners.clear();
  }

  /** Líneas corruptas saltadas desde el arranque (diagnóstico/tests). */
  get skippedCount(): number {
    return this.skipped;
  }

  // === Internos ===

  private emit(raw: unknown): void {
    for (const cb of this.listeners) cb(raw);
  }

  private ensureFile(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // 'a' crea el archivo si falta sin truncar si ya existe.
      fs.closeSync(fs.openSync(this.filePath, 'a'));
    } catch {
      // Si no podemos crear el archivo, drain() degradará a no-op
      // (statSync falla → return). No es fatal para la activación.
    }
  }

  private readFrom(from: number, to: number): Buffer {
    const length = to - from;
    if (length <= 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(this.filePath, 'r');
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buf, 0, length, from);
    } finally {
      fs.closeSync(fd);
    }
    // El offset avanza SOLO por lo realmente leído: si readSync devolvió
    // menos bytes de los pedidos, el resto se re-lee en el próximo drain
    // en vez de perderse.
    this.offset = from + bytesRead;
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  }
}
