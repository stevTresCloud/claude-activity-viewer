/* ================================================================
 * bridge.ts — Store del viewer + puente extension ↔ webview.
 *
 * Re-enfoque a visualizador read-only: el bridge YA NO lanza ni
 * coordina agentes. Es el store del observador. Su fuente de datos
 * es el ingester (eventos de hooks de Claude Code traducidos a
 * `DashboardEventToWebview`), que entran por `ingest()`.
 *
 * Responsabilidades:
 *   1. Registry en memoria de agentes observados (vivos + terminados).
 *   2. Aplicar los eventos del ingester al registry y reemitirlos a
 *      todos los webviews attached (sidebar + detail panel).
 *   3. Persistir snapshot + logs en `context.globalState` con TTL
 *      30 días, recovery de huérfanos al activate.
 *   4. Ringbuffer de log per-agent (FIFO bounded) para el detail panel.
 *
 * Single source of truth del state del dashboard. El ingester es el
 * único productor (vía `ingest`); el scanner-controller publica sus
 * propios eventos de disco vía `emit` (passthrough sin registry).
 * ================================================================ */

import * as vscode from 'vscode';
import { ts } from '../shared/format';
import { readTranscriptMetrics } from './transcript-reader';
import {
  LOG_RING_MAX,
  isTerminalStatus,
  type AgentCompletedResult,
  type AgentSnapshot,
  type AgentStatus,
  type DashboardEventToWebview,
  type LogEntry,
} from '../shared/dashboard-protocol';

// === Constantes ===

const STATE_KEY = 'claudeOrchestrator.agents';
// LOG_RING_MAX vive en shared/dashboard-protocol.ts — bridge y store
// del webview lo respetan en paralelo (importan desde el mismo lugar).
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
const PERSIST_DEBOUNCE_MS = 500;

// === Tipos internos ===

/**
 * Forma del snapshot que persistimos en `context.globalState`.
 * Reusa `AgentSnapshot` (el del wire) más el log bounded — así un
 * reload del webview puede reconstruir state + detail panel. El cwd
 * vive en `snapshot.cwd` (wire); no se duplica acá.
 */
interface StoredAgent {
  snapshot: AgentSnapshot;
  log: LogEntry[];
}

/**
 * Payload del listener `onAgentCompleted`. Se dispara una sola vez
 * por agente, cuando entra a estado terminal. Lo consume el
 * CompletionNotifier (toast VS Code).
 */
export interface AgentCompletionEvent {
  agentId: string;
  name: string;
  status: 'done' | 'failed' | 'cancelled';
  /** Undefined cuando no vimos el arranque del agente (ver AgentCompletedResult). */
  durationMs?: number;
  tokensUsed: number;
  reason?: string;
}

// === Listener helper ===

/**
 * Helper genérico para los 3 arrays de callbacks del bridge
 * (`attachListeners`, `runningCountListeners`, `completionListeners`).
 * Encapsula el patrón `push + dispose + iterate-with-catch + log`.
 *
 * Convención: `T = void` para listeners sin payload (se llama
 * `emit(undefined)`).
 */
class Listeners<T> {
  private readonly cbs: Array<(arg: T) => void> = [];

  constructor(
    private readonly channel: vscode.OutputChannel,
    private readonly label: string,
  ) {}

  /**
   * Suscribe un callback. Devuelve la función de des-registro.
   * Idempotente: llamar al dispose dos veces no rompe (la segunda
   * no encuentra el cb y es no-op).
   */
  add(cb: (arg: T) => void): () => void {
    this.cbs.push(cb);
    return () => {
      const i = this.cbs.indexOf(cb);
      if (i >= 0) this.cbs.splice(i, 1);
    };
  }

  /**
   * Invoca a TODOS los listeners con el mismo arg. Tolerante a
   * fallos: una excepción en un listener no impide que el resto se
   * ejecute. NO es re-entrant (ningún listener actual lo necesita).
   */
  emit(arg: T): void {
    if (this.cbs.length === 0) return;
    for (const cb of this.cbs) {
      try {
        cb(arg);
      } catch (err) {
        this.channel.appendLine(
          `[${ts()}] [bridge] ${this.label} listener error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

// === Bridge ===

export interface DashboardBridgeOptions {
  context: vscode.ExtensionContext;
  channel: vscode.OutputChannel;
}

/**
 * Punto de entrada único para "observar agentes" desde el ingester y
 * reflejarlos en la UI. Ver docstring de archivo.
 */
export class DashboardBridge {
  private readonly context: vscode.ExtensionContext;
  private readonly channel: vscode.OutputChannel;

  // Registry en memoria. Map para lookup O(1) por id; el orden de
  // inserción es estable y sirve para serializar reproducible.
  private readonly agents = new Map<string, StoredAgent>();

  // Webviews vivos attached: sidebar (DashboardViewProvider) + detail
  // panel (editor tab, on-demand). El bridge broadcastea todos los
  // eventos a TODOS; cada webview filtra del lado Vue lo que le importa.
  private readonly webviews = new Set<vscode.Webview>();

  // Callbacks post-`attachWebview`. Los usa el scanner-controller para
  // re-emitir su último resultado de disco cuando el sidebar se reabre.
  private readonly attachListeners: Listeners<void>;

  // Listeners del count de agentes running (status bar).
  private readonly runningCountListeners: Listeners<number>;

  // Listeners de "agente entró en estado terminal" (CompletionNotifier).
  private readonly completionListeners: Listeners<AgentCompletionEvent>;

  // Persistencia debounced: cada evento agenda un flush; sucesivos
  // mientras el timer corre se colapsan en uno solo.
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(options: DashboardBridgeOptions) {
    this.context = options.context;
    this.channel = options.channel;
    this.attachListeners = new Listeners<void>(this.channel, 'attach');
    this.runningCountListeners = new Listeners<number>(this.channel, 'running-count');
    this.completionListeners = new Listeners<AgentCompletionEvent>(
      this.channel,
      'completion',
    );
  }

  // ====================================================================
  // === Lifecycle ======================================================
  // ====================================================================

  /**
   * Hydrate al activate. Lee globalState, marca agentes huérfanos
   * (status='running' que sobrevivieron a un restart) como failed con
   * reason='ide_restart', y aplica cleanup TTL de items completed >30 días.
   *
   * NO emite eventos al webview — todavía no hay uno attached. Cuando el
   * webview attache, recibe el agent_list completo.
   *
   * Nota viewer: un agente observado que SIGUE vivo tras un reload del
   * IDE se marca como huérfano acá (failed/ide_restart). Si después el
   * ingester re-emite eventos vivos de ese agente, lo resucitamos en
   * `reactivateIfOrphan` — el huérfano era una conjetura, no un cierre real.
   */
  async hydrate(): Promise<void> {
    const stored = this.context.globalState.get<StoredAgent[]>(STATE_KEY, []);
    const now = Date.now();
    let orphaned = 0;
    let evicted = 0;

    for (const entry of stored) {
      // === Cleanup TTL: items completados hace >30 días se descartan. ===
      if (entry.snapshot.completedAtIso) {
        const completedMs = Date.parse(entry.snapshot.completedAtIso);
        if (now - completedMs > TTL_MS) {
          evicted++;
          continue;
        }
      }

      // === Recovery de huérfanos ===
      // Un agente que sigue 'running' al hydrate es huérfano: el IDE se
      // reinició. Lo marcamos failed para que aparezca en RECENT con
      // razón clara en vez de quedar "running" para siempre.
      if (entry.snapshot.status === 'running') {
        entry.snapshot.status = 'failed';
        entry.snapshot.reason = 'ide_restart';
        entry.snapshot.completedAtIso = new Date(now).toISOString();
        orphaned++;
      }

      this.agents.set(entry.snapshot.id, {
        snapshot: entry.snapshot,
        log: entry.log ?? [],
      });
    }

    if (orphaned > 0 || evicted > 0) {
      this.channel.appendLine(
        `[${ts()}] [bridge] hydrate orphaned=${orphaned} evicted=${evicted} total=${this.agents.size}`,
      );
      await this.context.globalState.update(STATE_KEY, this.serialize());
    }
    // Tras hidratar el status bar arranca con el count correcto sin
    // esperar al primer evento del ingester.
    this.notifyRunningCount();
  }

  /**
   * Attach del webview vivo. Llamado por DashboardViewProvider y por
   * el DetailPanelManager. Manda agent_list para hidratar el store del
   * lado Vue con el snapshot actual.
   *
   * Retorna el webview attachado — el caller debe pasarlo a
   * `detachWebview(token)` al cerrar el view para no desconectar un
   * attach posterior.
   */
  attachWebview(webview: vscode.Webview): vscode.Webview {
    this.webviews.add(webview);
    const agents = this.snapshotList();
    this.channel.appendLine(
      `[${ts()}] [bridge] webview attached (total=${this.webviews.size}), hydrating ${agents.length} agents`,
    );
    // Hidratamos SOLO al webview nuevo, no broadcast: los otros ya
    // tienen su state y un agent_list les vaciaría los logs.
    webview.postMessage({ type: 'agent_list', agents });
    // Notificamos a los suscriptores (scanner-controller) para que
    // re-emitan su último cache al webview. Fire-and-forget.
    this.attachListeners.emit(undefined);
    return webview;
  }

  /**
   * Registra un callback que se invoca cada vez que un webview nuevo se
   * attache. Pensado para que el scanner-controller re-hidrate su slice.
   * Retorna una función de des-registro.
   */
  onAttach(cb: () => void): () => void {
    return this.attachListeners.add(cb);
  }

  /**
   * VS Code cierra un webview, lo sacamos del set. Idempotente — si el
   * token ya no estaba, el delete es no-op.
   */
  detachWebview(token: vscode.Webview): void {
    if (this.webviews.delete(token)) {
      this.channel.appendLine(
        `[${ts()}] [bridge] webview detached (total=${this.webviews.size})`,
      );
    }
  }

  // ====================================================================
  // === Ingest (eventos del ingester → store) ==========================
  // ====================================================================

  /**
   * Entrada única del ingester. Aplica un `DashboardEventToWebview` ya
   * traducido al registry y lo reemite a los webviews. Espejo de lo que
   * antes hacían `spawn`/`run` con el AgentRunner, pero invertido: acá
   * los eventos llegan armados (state machine del translator) y el
   * bridge solo mantiene su registry + persistencia + listeners.
   *
   * El ingester solo produce los 4 tipos `agent_*`. Si entra otro tipo es
   * un bug de cableado upstream (el translator emitió algo fuera de
   * contrato): lo logueamos y descartamos en vez de reenviarlo sin
   * trackear — un passthrough silencioso enmascararía ese bug.
   */
  ingest(event: DashboardEventToWebview): void {
    switch (event.type) {
      case 'agent_created':
        this.applyCreated(event.agent);
        break;
      case 'agent_status_changed':
        this.applyStatusChange(event.agentId, event.status, event.metadata);
        break;
      case 'agent_log':
        this.appendLog(event.agentId, event.entry);
        break;
      case 'agent_completed':
        this.applyCompleted(event.agentId, event.result);
        break;
      default:
        this.channel.appendLine(
          `[${ts()}] [bridge] ingest: tipo inesperado "${event.type}" (ignorado)`,
        );
        break;
    }
  }

  /**
   * Alta de un agente observado. Idempotente: el translator ya deduplica
   * SubagentStart, pero si un re-proceso del spool reenvía el created no
   * duplicamos la entry ni el card.
   *
   * Excepción: si el agente ya existe pero está en recovery de huérfano
   * (failed/ide_restart), un created nuevo significa que el agente revive
   * → lo reactivamos y reemitimos status running (NO un agent_created, que
   * duplicaría el card del lado webview).
   */
  private applyCreated(snapshot: AgentSnapshot): void {
    if (this.agents.has(snapshot.id)) {
      if (this.reactivateIfOrphan(snapshot.id)) {
        const lastActivityIso = this.agents.get(snapshot.id)?.snapshot.lastActivityIso;
        this.post({
          type: 'agent_status_changed',
          agentId: snapshot.id,
          status: 'running',
          metadata: { lastActivityIso },
        });
        this.schedulePersist();
        this.notifyRunningCount();
      }
      return;
    }
    this.agents.set(snapshot.id, {
      snapshot: { ...snapshot },
      log: [],
    });
    this.post({ type: 'agent_created', agent: { ...snapshot } });
    this.schedulePersist();
    // Nuevo agente running → refrescamos el count del status bar.
    this.notifyRunningCount();
  }

  /**
   * ¿El snapshot está en recovery de huérfano? Es el estado "blando" que
   * pone `hydrate()` (failed con reason='ide_restart') cuando un agente
   * sobrevive a un reload del IDE: una conjetura de que murió, no un
   * cierre real. Se distingue de un terminal "duro" (un SubagentStop real,
   * o failed/cancelled con otra razón) que NO debe revertirse nunca.
   */
  private isOrphanRecovery(snapshot: AgentSnapshot): boolean {
    return snapshot.status === 'failed' && snapshot.reason === 'ide_restart';
  }

  /**
   * Si el agente está en recovery de huérfano, lo devuelve a `running` y
   * limpia los marcadores terminales (reason/completedAtIso/durationMs).
   * Reconcilia el registry con lo que el ingester volvió a emitir: sin
   * esto, el guard terminal de `mutateSnapshot` dejaría el registry en
   * `failed` mientras el webview recibe eventos `running` → divergencia
   * hasta el próximo reload. Devuelve true si resucitó algo (el caller
   * decide si reemitir/persistir/refrescar el count).
   */
  private reactivateIfOrphan(agentId: string): boolean {
    const stored = this.agents.get(agentId);
    if (!stored || !this.isOrphanRecovery(stored.snapshot)) return false;
    stored.snapshot.status = 'running';
    delete stored.snapshot.reason;
    delete stored.snapshot.completedAtIso;
    delete stored.snapshot.durationMs;
    // El evento vivo que dispara la resurrección ES actividad reciente:
    // sellamos lastActivityIso para que el agente no aparezca "idle" por
    // un startedAtIso viejo (caso huérfano de un snapshot pre-liveness).
    stored.snapshot.lastActivityIso = new Date().toISOString();
    this.channel.appendLine(
      `[${ts()}] [bridge] resurrect orphan agent=${agentId.slice(0, 8)} (live event after ide_restart)`,
    );
    return true;
  }

  /**
   * Muta el snapshot del registry respetando el invariante "una vez
   * terminal, no vuelve a running" (no degrada el status) y mergea
   * metadata útil. Única ruta de escritura del snapshot — la comparten
   * `applyStatusChange` y `applyCompleted` para que el guard terminal
   * viva en un solo lugar. No emite ni persiste; eso lo hace el caller.
   */
  private mutateSnapshot(
    agentId: string,
    status: AgentStatus,
    metadata?: Partial<AgentSnapshot>,
  ): void {
    const stored = this.agents.get(agentId);
    if (!stored) return;
    if (!isTerminalStatus(stored.snapshot.status)) {
      stored.snapshot.status = status;
    }
    if (metadata) {
      Object.assign(stored.snapshot, metadata);
    }
  }

  /**
   * Aplica un cambio de status/metadata al registry y lo reemite. No
   * notifica count acá (los cambios mid-run son status='running'); el
   * terminal lo notifica `applyCompleted`.
   */
  private applyStatusChange(
    agentId: string,
    status: AgentStatus,
    metadata?: Partial<AgentSnapshot>,
  ): void {
    // Huérfano que revive: un evento vivo (running/tool) sobre un agente
    // marcado failed/ide_restart lo reactiva antes de aplicar el cambio.
    const resurrected = this.reactivateIfOrphan(agentId);
    this.mutateSnapshot(agentId, status, metadata);
    this.post({ type: 'agent_status_changed', agentId, status, metadata });
    this.schedulePersist();
    // failed→running suma 1 al count de running; los cambios normales
    // mid-run no lo mueven, por eso solo notificamos al resucitar.
    if (resurrected) this.notifyRunningCount();
  }

  /**
   * Cierre de un agente observado. Fija el state terminal en el registry
   * (vía `mutateSnapshot`, misma ruta y mismo guard que los demás
   * cambios de status), reemite el `agent_completed`, dispara la
   * notificación de completion (toast) y refresca el count del status bar.
   *
   * El translator emite un `agent_status_changed` status='done' (con
   * completedAtIso/durationMs) ANTES del completed, así que esos campos
   * ya suelen estar en el snapshot; el guard de completedAtIso evita pisarlo.
   */
  private applyCompleted(agentId: string, result: AgentCompletedResult): void {
    // Un SubagentStop real tras un restart override-a el ide_restart: el
    // agente sí terminó, solo que el cierre llegó después del reload.
    this.reactivateIfOrphan(agentId);
    const stored = this.agents.get(agentId);
    const metadata: Partial<AgentSnapshot> = {
      tokensUsed: result.tokensUsed,
    };
    // durationMs es opcional: cuando no vimos el arranque queda undefined y
    // NO lo escribimos (la UI muestra "—" en vez de "0s").
    if (result.durationMs !== undefined) {
      metadata.durationMs = result.durationMs;
    }
    if (stored && !stored.snapshot.completedAtIso) {
      metadata.completedAtIso = new Date().toISOString();
    }
    if (result.reason) {
      metadata.reason = result.reason;
    }
    this.mutateSnapshot(agentId, result.status, metadata);
    this.post({ type: 'agent_completed', agentId, result });
    // notifyCompletion (toast) solo para los 3 estados terminales con
    // payload de cierre. El guard además narrowea el tipo a la firma
    // de AgentCompletionEvent.
    if (
      stored &&
      (result.status === 'done' ||
        result.status === 'failed' ||
        result.status === 'cancelled')
    ) {
      this.notifyCompletion({
        agentId,
        name: stored.snapshot.name,
        status: result.status,
        durationMs: result.durationMs,
        tokensUsed: result.tokensUsed,
        reason: stored.snapshot.reason,
      });
    }
    this.schedulePersist();
    this.notifyRunningCount();
  }

  /**
   * Emite el ringbuffer completo de logs de un agente como un único
   * `agent_log_history`. Llamado on-demand cuando el detail panel se
   * monta y necesita hidratar el LogStream con todo el histórico.
   *
   * Un solo evento batch en vez de re-emitir N×`agent_log` evita N
   * round-trips postMessage. Si el webview que pidió la hidratación se
   * conoce, se pasa como `targetWebview` y el evento va SOLO a ese.
   *
   * No-op coherente si el agentId no existe (emite `entries: []`).
   */
  /**
   * Nombre del agente para títulos de UI (ej. tab del detail panel).
   * Devuelve null si el agentId no está en el registry.
   */
  getAgentName(agentId: string): string | null {
    return this.agents.get(agentId)?.snapshot.name ?? null;
  }

  hydrateLogs(agentId: string, targetWebview?: vscode.Webview): void {
    const stored = this.agents.get(agentId);
    const entries = stored ? [...stored.log] : [];
    this.channel.appendLine(
      `[${ts()}] [bridge] hydrate logs agent=${agentId.slice(0, 8)} entries=${entries.length}`,
    );
    const event = { type: 'agent_log_history' as const, agentId, entries };
    if (targetWebview) {
      targetWebview.postMessage(event);
    } else {
      this.post(event);
    }
  }

  /**
   * Lee el transcript del agente (modelo / tokens / context%) y emite
   * `agent_metrics` al webview que pidió la hidratación. On-demand: solo
   * cuando el detail panel se monta. Degrada en silencio — si el agente
   * no tiene `transcriptPath` o el parseo no devuelve nada, no emite y la
   * UI deja ContextBar/ModelBadge ocultos. No muta el registry (espejo de
   * `hydrateLogs`: emisión read-only al webview solicitante).
   */
  async hydrateMetrics(
    agentId: string,
    targetWebview?: vscode.Webview,
  ): Promise<void> {
    const stored = this.agents.get(agentId);
    const metrics = await readTranscriptMetrics(stored?.snapshot.transcriptPath);
    if (Object.keys(metrics).length === 0) return;
    this.channel.appendLine(
      `[${ts()}] [bridge] hydrate metrics agent=${agentId.slice(0, 8)} model=${metrics.model ?? '—'}`,
    );
    const event = { type: 'agent_metrics' as const, agentId, metrics };
    if (targetWebview) {
      targetWebview.postMessage(event);
    } else {
      this.post(event);
    }
  }

  /**
   * Suscripción al cambio de cantidad de agentes `running` (status bar).
   * Emite el count actual al suscribirse para que el StatusBar se pinte
   * coherente sin esperar al primer cambio.
   */
  onRunningCountChange(cb: (count: number) => void): () => void {
    const off = this.runningCountListeners.add(cb);
    cb(this.getRunningCount());
    return off;
  }

  /** Cantidad de agentes en estado `running` ahora mismo. */
  getRunningCount(): number {
    let n = 0;
    for (const stored of this.agents.values()) {
      if (stored.snapshot.status === 'running') n++;
    }
    return n;
  }

  private notifyRunningCount(): void {
    this.runningCountListeners.emit(this.getRunningCount());
  }

  /**
   * Suscripción a "agente entró en estado terminal". Dispara una vez por
   * agente, justo después de mutar el snapshot al estado terminal. No
   * re-emite eventos pasados al suscribirse.
   */
  onAgentCompleted(cb: (event: AgentCompletionEvent) => void): () => void {
    return this.completionListeners.add(cb);
  }

  private notifyCompletion(event: AgentCompletionEvent): void {
    this.completionListeners.emit(event);
  }

  // ====================================================================
  // === Emisión de eventos =============================================
  // ====================================================================

  /**
   * Append a log + emitir agent_log al webview. El ringbuffer se mantiene
   * en `stored.log` (per-agent, FIFO bounded por LOG_RING_MAX).
   */
  private appendLog(agentId: string, entry: LogEntry): void {
    const stored = this.agents.get(agentId);
    if (stored) {
      stored.log.push(entry);
      if (stored.log.length > LOG_RING_MAX) {
        stored.log.shift();
      }
    }
    this.post({ type: 'agent_log', agentId, entry });
    this.schedulePersist();
  }

  /**
   * Broadcast a TODOS los webviews attached. Si no hay ninguno, el evento
   * se descarta (no hay queue interna). postMessage es fire-and-forget.
   */
  private post(event: DashboardEventToWebview): void {
    for (const w of this.webviews) {
      w.postMessage(event);
    }
  }

  /**
   * Entry point público para que controladores externos (scanner-
   * controller) publiquen eventos de disco al webview sin tocar el
   * registry. Mismo fire-and-forget que el post interno.
   */
  emit(event: DashboardEventToWebview): void {
    this.post(event);
  }

  // ====================================================================
  // === Persistencia ===================================================
  // ====================================================================

  /** Agenda flush con debounce. Múltiples calls dentro de la ventana colapsan. */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    // Capturamos el snapshot SYNC antes del await para que dos flushes
    // solapados no dejen un snapshot viejo encima del nuevo.
    const snapshot = this.serialize();
    try {
      await this.context.globalState.update(STATE_KEY, snapshot);
    } catch (err) {
      this.channel.appendLine(
        `[${ts()}] [bridge] !!! persist error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private serialize(): StoredAgent[] {
    return Array.from(this.agents.values());
  }

  // ====================================================================
  // === Disposal =======================================================
  // ====================================================================

  async dispose(): Promise<void> {
    // Flush final: perder la última hornada de cambios deja datos
    // inconsistentes en el próximo activate. (El ingester se dispone
    // por separado en extension.ts; acá no hay subprocess que matar.)
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.flush();
  }

  // ====================================================================
  // === Helpers internos ===============================================
  // ====================================================================

  private snapshotList(): AgentSnapshot[] {
    // Spread copy: el webview no debe ver mutaciones del registry. Shallow
    // alcanza porque AgentSnapshot es plano (primitivos / strings / numbers).
    return Array.from(this.agents.values()).map((s) => ({ ...s.snapshot }));
  }
}
