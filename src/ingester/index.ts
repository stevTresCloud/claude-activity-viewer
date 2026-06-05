/* ================================================================
 * index.ts — Fachada del ingester.
 *
 * Une las tres piezas del motor del viewer:
 *   event-source (tail del NDJSON) → parseHookEvent (validación) →
 *   HookTranslator (mapping a eventos del store).
 *
 * El consumidor (extension host) registra un único callback `onEvents`
 * que recibe los `DashboardEventToWebview` ya traducidos. En F1 ese
 * callback loguea (smoke); en F2 alimenta el store del kanban.
 * ================================================================ */

import type { DashboardEventToWebview } from '../shared/dashboard-protocol';
import { JsonlEventSource, type HookEventSource } from './event-source';
import { parseHookEvent } from './hook-events';
import { HookTranslator, type DerivedContext } from './translator';

export interface IngesterDeps {
  source: HookEventSource;
  translator: HookTranslator;
  /** Recibe los eventos traducidos listos para el store. */
  onEvents: (events: DashboardEventToWebview[]) => void;
  /** Sink opcional de diagnóstico (eventos descartados, etc.). */
  log?: (msg: string) => void;
}

export class Ingester {
  private readonly source: HookEventSource;
  private readonly translator: HookTranslator;
  private readonly onEvents: (events: DashboardEventToWebview[]) => void;
  private readonly log?: (msg: string) => void;
  private unsubscribe?: () => void;

  constructor(deps: IngesterDeps) {
    this.source = deps.source;
    this.translator = deps.translator;
    this.onEvents = deps.onEvents;
    this.log = deps.log;
  }

  start(): void {
    this.unsubscribe = this.source.onEvent((raw) => this.handleRaw(raw));
    this.source.start();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.source.dispose();
  }

  private handleRaw(raw: unknown): void {
    const parsed = parseHookEvent(raw);
    if (!parsed.ok) {
      this.log?.(`[ingester] dropped event: ${parsed.reason}`);
      return;
    }
    const events = this.translator.translate(parsed.event);
    if (events.length > 0) this.onEvents(events);
  }
}

export interface FileIngesterOptions {
  eventsFile: string;
  deriveContext: (cwd: string) => DerivedContext;
  onEvents: (events: DashboardEventToWebview[]) => void;
  log?: (msg: string) => void;
}

/**
 * Arma un Ingester con transporte de archivo NDJSON. Atajo para el
 * wiring del extension host: una sola llamada construye source +
 * translator + fachada.
 */
export function createFileIngester(opts: FileIngesterOptions): Ingester {
  const source = new JsonlEventSource({ filePath: opts.eventsFile, log: opts.log });
  const translator = new HookTranslator({ deriveContext: opts.deriveContext });
  return new Ingester({
    source,
    translator,
    onEvents: opts.onEvents,
    log: opts.log,
  });
}

export { parseHookEvent } from './hook-events';
export { HookTranslator } from './translator';
export { JsonlEventSource } from './event-source';
export {
  installHook,
  uninstallHook,
  isHookInstalled,
  defaultHookPaths,
  buildHookEntry,
  type HookPaths,
  type InstallResult,
  type UninstallResult,
} from './hook-installer';
export { HOOK_EVENT_NAMES } from './hook-events';
