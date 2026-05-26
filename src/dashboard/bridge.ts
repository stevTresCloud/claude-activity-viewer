/* ================================================================
 * bridge.ts — Supervisor del dashboard + puente extension ↔ webview.
 *
 * Responsabilidades en una sola clase:
 *   1. Registry de agentes vivos + completados en memoria.
 *   2. Lanzar un agente vía AgentRunner y reemitir sus eventos al
 *      webview en tiempo real (postMessage).
 *   3. Persistir snapshot + logs en `context.globalState` con TTL
 *      30 días, cleanup al activate, marcado "ide_restart" para
 *      huérfanos.
 *   4. Derivar project/task/branch del cwd según §9.2 del brief.
 *   5. Ringbuffer de log per-agent (1000 entries FIFO) para que un
 *      futuro detail panel tenga histórico sin reventar memoria.
 *
 * Por qué una sola clase y no tres:
 *   El registry, el supervisor de runs y el persister están
 *   acoplados: un evento del runner muta el registry, dispara
 *   postMessage Y agenda persistencia. Separarlos en clases
 *   distintas multiplica indirecciones para cero ganancia
 *   conceptual mientras el dominio sea "agentes en memoria + log
 *   bounded + 1 webview". Si en v0.2 entra multi-window /
 *   multi-runner, se reabre.
 *
 * Single source of truth para el state del dashboard. Cualquier
 * actor (MCP handler, palette command) que quiera lanzar un
 * agente PASA por bridge.spawn — nunca llama runner.startAgent
 * directo.
 * ================================================================ */

import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentRunner } from '../runtime/agent-runner';
import {
  DEFAULT_MODEL,
  MODEL_ALIASES,
  type AgentEvent,
  type AgentStatus as RuntimeAgentStatus,
  type ModelAlias,
} from '../runtime/types';
import { logAgentEvent, ts } from '../runtime/log';
import { capitalize } from '../shared/format';
import {
  LOG_RING_MAX,
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
const TTL_MS = 30 * 24 * 60 * 60 * 1000;       // 30 días
const PERSIST_DEBOUNCE_MS = 500;
/**
 * Ventana de contexto efectiva en tokens. Claude 4 hoy reporta
 * 200k de contexto público. Usado para derivar contextUsedPct =
 * (input_tokens / CONTEXT_WINDOW_TOKENS) * 100.
 *
 * Cuando el SDK reporte un campo `context_window` propio, se
 * deprecará. Mientras tanto, 200k es el número con el que el SDK
 * mismo trabaja (`maxTurns` no acota el contexto, solo las idas y
 * vueltas).
 */
const CONTEXT_WINDOW_TOKENS = 200_000;

// === Tipos internos ===

/**
 * Forma del snapshot que persistimos en `context.globalState`.
 * Reusa `AgentSnapshot` (el del wire) más el log bounded — así un
 * reload del webview puede reconstruir state + (eventualmente)
 * detail panel.
 *
 * `cwd` y `prompt` viven acá pero NO en el wire — la UI hoy no
 * los necesita, pero sí los pedirán features futuras como el
 * panel de detalle (mostrar con qué se lanzó el agente) y el
 * scanner de sesiones (resume desde un cwd histórico).
 */
interface StoredAgent {
  snapshot: AgentSnapshot;
  cwd: string;
  prompt: string;
  log: LogEntry[];
}

/** Input para `bridge.spawn`. Conecta MCP handler / palette command. */
export interface SpawnInput {
  /** Display name del agente. Opcional: fallback agent-<shortid>. */
  name?: string;
  prompt: string;
  cwd: string;
  /** Override de la resolución del project (opciones.project del MCP). */
  projectOverride?: string;
  /** Lo agrupa visualmente con otros agentes del mismo batch_id. */
  batchId?: string;
  /**
   * Alias del modelo a pedirle al SDK. Default DEFAULT_MODEL. El
   * SDK puede resolverlo a un id distinto; el model badge se
   * actualiza al recibir el `system.init` con el id efectivo.
   */
  model?: ModelAlias;
}

/** Output sincrónico de spawn. La promise `finished` resuelve cuando termina. */
export interface SpawnOutput {
  agentId: string;
  finished: Promise<void>;
}

/**
 * Payload del listener `onAgentCompleted`. Se dispara una sola vez
 * por agente, en el bloque terminal del run. Lo consumen
 * post-completion hooks (toast notification, analytics futura).
 */
export interface AgentCompletionEvent {
  agentId: string;
  name: string;
  status: 'done' | 'failed' | 'cancelled';
  durationMs: number;
  tokensUsed: number;
  reason?: string;
}

// === Bridge ===

export interface DashboardBridgeOptions {
  context: vscode.ExtensionContext;
  channel: vscode.OutputChannel;
  runner: AgentRunner;
}

/**
 * Punto de entrada único para "lanzar y observar agentes" desde
 * cualquier rincón de la extensión. Ver docstring de archivo.
 */
export class DashboardBridge {
  private readonly context: vscode.ExtensionContext;
  private readonly channel: vscode.OutputChannel;
  private readonly runner: AgentRunner;

  // Registry en memoria. Mantener Map para lookup O(1) por id —
  // el orden de inserción es estable y nos sirve para serializar
  // a array de forma reproducible.
  private readonly agents = new Map<string, StoredAgent>();
  private readonly aborts = new Map<string, AbortController>();
  // Promises de runs en vuelo. Las trackeamos para que dispose()
  // pueda esperarlas con allSettled antes del flush final — si no
  // las espera, el flush captura el state PRE-terminal de los
  // agentes en cancelAll() y al próximo activate quedan marcados
  // como huérfanos (failed/ide_restart) en vez de cancelled.
  private readonly activeRuns = new Set<Promise<void>>();

  // Webviews vivos attached. Hoy hay potencialmente dos:
  //   1. Sidebar (DashboardViewProvider).
  //   2. Detail panel (editor tab, abierto on-demand).
  // El bridge broadcastea todos los eventos a TODOS los webviews
  // attached; cada webview filtra del lado Vue lo que le interesa.
  // El set permite attach/detach independientes sin perder al otro.
  private readonly webviews = new Set<vscode.Webview>();

  // Callbacks invocados después de cada `attachWebview`. Los usa
  // el scanner-controller para re-emitir su último resultado: sin
  // esto, cerrar y reabrir el sidebar deja la sección PAST SESSIONS
  // vacía hasta el siguiente tick del auto-refresh.
  private readonly attachCallbacks: Array<() => void> = [];

  // Listeners del count de agentes running. Lo consume el
  // StatusBar item (extension host). Mantenemos array porque la
  // suscripción/de-suscripción es rara (1 por activación de la
  // extension); no vale la pena un Set.
  private readonly runningCountListeners: Array<(count: number) => void> = [];

  // Listeners de "agente entró en estado terminal". Lo consume el
  // CompletionNotifier (toast VS Code). Mismo patrón que
  // runningCountListeners — 1 listener fijo por activación, array OK.
  private readonly completionListeners: Array<
    (event: AgentCompletionEvent) => void
  > = [];

  // Persistencia debounced: cada evento agenda un flush, sucesivos
  // mientras el timer corre se colapsan en uno solo. Sin esto, un
  // agente verboso (cientos de tool_use/sec) generaría N writes
  // por segundo al globalState — fallaría rendimiento de VS Code.
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(options: DashboardBridgeOptions) {
    this.context = options.context;
    this.channel = options.channel;
    this.runner = options.runner;
  }

  // ====================================================================
  // === Lifecycle ======================================================
  // ====================================================================

  /**
   * Hydrate al activate de la extensión. Lee globalState, marca
   * agentes huérfanos (status='running' que sobrevivieron a
   * restart) como failed con reason='ide_restart', y aplica
   * cleanup TTL de items completed >30 días.
   *
   * NO emite eventos al webview — todavía no hay uno attached.
   * Cuando el webview attache, recibe el agent_list completo.
   */
  async hydrate(): Promise<void> {
    const stored = this.context.globalState.get<StoredAgent[]>(STATE_KEY, []);
    const now = Date.now();
    let orphaned = 0;
    let evicted = 0;

    for (const entry of stored) {
      // === Cleanup TTL ===
      // Items completados hace >30 días se descartan.
      if (entry.snapshot.completedAtIso) {
        const completedMs = Date.parse(entry.snapshot.completedAtIso);
        if (now - completedMs > TTL_MS) {
          evicted++;
          continue;
        }
      }

      // === Recovery de huérfanos ===
      // Un agente que sigue en 'running' al hydrate es huérfano:
      // su subprocess murió con la EDH previa. Lo marcamos failed
      // para que el user lo vea en RECENT con razón clara.
      if (entry.snapshot.status === 'running') {
        entry.snapshot.status = 'failed';
        entry.snapshot.reason = 'ide_restart';
        entry.snapshot.completedAtIso = new Date(now).toISOString();
        orphaned++;
      }

      this.agents.set(entry.snapshot.id, entry);
    }

    if (orphaned > 0 || evicted > 0) {
      this.channel.appendLine(
        `[${ts()}] [bridge] hydrate orphaned=${orphaned} evicted=${evicted} total=${this.agents.size}`,
      );
      // Persistimos sync porque el set de cambios es de una sola
      // pasada y no queremos que la primera escritura del bridge
      // post-hydrate se demore por el debounce.
      await this.context.globalState.update(STATE_KEY, this.serialize());
    }
    // Tras hidratar puede haber huérfanos marcados failed/cancelled
    // (o ninguno running todavía). Notificamos para que el status
    // bar arranque con el count correcto sin esperar al primer
    // spawn.
    this.notifyRunningCount();
  }

  /**
   * Attach del webview vivo. Llamado por DashboardViewProvider en
   * `resolveWebviewView`. Manda agent_list para hidratar el store
   * del lado Vue con el snapshot actual.
   *
   * Retorna el webview attachado — el caller debe pasarlo a
   * `detachWebview(token)` al cerrar el view para evitar
   * desconectar un attach posterior (VS Code puede invocar
   * resolveWebviewView dos veces sin onDidDispose intermedio
   * cuando el view migra entre sidebars).
   */
  attachWebview(webview: vscode.Webview): vscode.Webview {
    this.webviews.add(webview);
    const agents = this.snapshotList();
    this.channel.appendLine(
      `[${ts()}] [bridge] webview attached (total=${this.webviews.size}), hydrating ${agents.length} agents`,
    );
    // Hidratamos SOLO al webview nuevo, no broadcast. Los otros
    // webviews ya tienen su state y no deben recibir un agent_list
    // que les fuerce un applyAgentList que vacía sus logs.
    webview.postMessage({ type: 'agent_list', agents });
    // Notificamos a los suscriptores (scanner-controller) para que
    // re-emitan su último cache al webview. Fire-and-forget; un
    // callback que tire no debe romper attach.
    for (const cb of this.attachCallbacks) {
      try {
        cb();
      } catch (err) {
        this.channel.appendLine(
          `[${ts()}] [bridge] attach callback error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return webview;
  }

  /**
   * Registra un callback que se invoca cada vez que un webview
   * nuevo se attache. Pensado para que módulos auxiliares
   * (scanner-controller) puedan re-hidratar su slice del state.
   *
   * Retorna una función de des-registro para limpieza si hace falta.
   */
  onAttach(cb: () => void): () => void {
    this.attachCallbacks.push(cb);
    return () => {
      const i = this.attachCallbacks.indexOf(cb);
      if (i >= 0) this.attachCallbacks.splice(i, 1);
    };
  }

  /**
   * Disposable: VS Code cierra un webview, lo sacamos del set.
   * Idempotente — si el token ya no estaba (porque otro detach corrió
   * primero, o el set se limpió por dispose() del bridge), el delete
   * es no-op. Los otros webviews attached siguen recibiendo eventos.
   */
  detachWebview(token: vscode.Webview): void {
    if (this.webviews.delete(token)) {
      this.channel.appendLine(
        `[${ts()}] [bridge] webview detached (total=${this.webviews.size})`,
      );
    }
  }

  // ====================================================================
  // === Spawn / cancel =================================================
  // ====================================================================

  /**
   * Punto de entrada único para lanzar un agente. Llamado por:
   *   - El handler MCP `spawn_agents` (uno por task del array).
   *   - El comando palette `claudeOrchestrator.testAgent`.
   *
   * Retorna sync con el `agentId` ya en el registry + UI. La
   * promise `finished` resuelve cuando el agente termina (útil
   * para MCP que quiere log de cierre, no para bloquear la
   * respuesta).
   */
  spawn(input: SpawnInput): SpawnOutput {
    const agentId = this.makeAgentId();
    const name = input.name ?? `agent-${agentId.slice(0, 8)}`;
    const batchId = input.batchId ?? `b-${agentId.slice(0, 8)}`;
    const context = deriveProjectContext(
      input.cwd,
      this.getProjectsRoot(),
      input.projectOverride,
    );

    const startedAtIso = new Date().toISOString();
    // Modelo inicial: prioridad
    //   1. input.model (lo que el caller pidió explícito en el MCP).
    //   2. setting `claudeOrchestrator.defaultModel` del user.
    //   3. DEFAULT_MODEL (hardcoded fallback 'sonnet').
    // El badge se sobrescribe con el id real cuando el SDK emita el
    // init message (AgentEvent type='model').
    const requestedModel = input.model ?? this.getDefaultModel();
    const snapshot: AgentSnapshot = {
      id: agentId,
      name,
      status: 'running',
      project: context.project,
      task: context.task,
      branch: context.branch,
      batchId,
      model: prettyModel(requestedModel),
      startedAtIso,
      elapsedMs: 0,
      tokensUsed: 0,
      contextUsedPct: 0,
    };

    const stored: StoredAgent = {
      snapshot,
      cwd: input.cwd,
      prompt: input.prompt,
      log: [],
    };
    this.agents.set(agentId, stored);

    const abort = new AbortController();
    this.aborts.set(agentId, abort);

    this.channel.appendLine(
      `[${ts()}] [bridge] spawn id=${agentId} name=${name} project=${context.project} cwd=${input.cwd}`,
    );
    this.post({ type: 'agent_created', agent: { ...snapshot } });
    this.schedulePersist();
    // Acaba de entrar un nuevo agente running — refrescamos el
    // count para el status bar.
    this.notifyRunningCount();

    // === Run en background ===
    // No await acá: el caller puede observar via `finished` si le
    // interesa, pero la respuesta del MCP retorna inmediato.
    //
    // Pasamos `requestedModel` resuelto (que ya aplicó el fallback
    // del setting) al runner. Sin esto, el runner recibe
    // `input.model` undefined y cae a su propio DEFAULT_MODEL,
    // ignorando el setting `claudeOrchestrator.defaultModel`.
    const resolvedInput: SpawnInput = { ...input, model: requestedModel };
    const finished = this.run(agentId, resolvedInput, abort.signal).catch((err) => {
      // Defensivo: el runner ya captura sus errores; solo entraría
      // acá si el dynamic import del SDK falla catastrófico.
      this.channel.appendLine(
        `[${ts()}] [bridge] !!! run uncaught id=${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    // Trackear para dispose(); cleanup cuando termine.
    this.activeRuns.add(finished);
    finished.finally(() => this.activeRuns.delete(finished));

    return { agentId, finished };
  }

  /**
   * Cancela un agente activo. Si no existe o ya terminó, no-op.
   * Lo consumirá el cancel UI button cuando se cablee, y se usa
   * también desde dispose() al apagar la EDH.
   */
  cancel(agentId: string): boolean {
    const abort = this.aborts.get(agentId);
    if (!abort) return false;
    this.channel.appendLine(`[${ts()}] [bridge] cancel id=${agentId}`);
    abort.abort();
    return true;
  }

  /** Cancela todos los agentes activos. Llamado en dispose. */
  cancelAll(): void {
    for (const id of this.aborts.keys()) {
      this.cancel(id);
    }
  }

  /**
   * Devuelve la info operacional que el handler `request_open`
   * necesita (sessionId + cwd) para abrir/resumir la sesión del
   * agente vivo. Mantenemos `cwd` fuera del wire AgentSnapshot —
   * vive solo en el bridge porque ningún componente Vue lo
   * renderea hoy, y el handler del scanner-controller lo necesita
   * server-side para invocar el URI handler del plugin claude-code.
   *
   * Nombrado por intención (no como "getMeta") para que no invite
   * a Vue consumers a tomar `cwd` de acá: el contrato es "datos
   * para resumir", no "metadata genérica de agente".
   *
   * Retorna `null` si el agentId no existe.
   */
  getResumeTarget(
    agentId: string,
  ): { sessionId?: string; cwd: string; name: string } | null {
    const stored = this.agents.get(agentId);
    if (!stored) return null;
    return {
      sessionId: stored.snapshot.sessionId,
      cwd: stored.cwd,
      name: stored.snapshot.name,
    };
  }

  /**
   * Lista plana de todos los agentes en el registry (vivos +
   * terminados que sobrevivieron al TTL del globalState). Lo
   * consume el handler MCP `list_agents` para que un chat externo
   * pueda preguntar "qué agentes tengo, en qué estado están".
   *
   * Retorna shallow copies del `AgentSnapshot` — el caller no debe
   * mutar el registry interno. Orden: insertion-order (los más
   * viejos primero).
   */
  listAgents(): AgentSnapshot[] {
    return Array.from(this.agents.values()).map((s) => ({ ...s.snapshot }));
  }

  /**
   * Devuelve el ringbuffer completo de logs del agente o null si
   * el agentId no existe. Si `since` viene, filtra entries con
   * `ts > since` (útil para paginación incremental: el MCP client
   * guarda el `ts` del último entry recibido y pide el delta).
   *
   * El consumidor del MCP `get_agent_log` lo usa para devolver
   * batches al chat externo sin mandar el ringbuffer entero cada
   * vez.
   */
  getAgentLog(
    agentId: string,
    since?: number,
  ): { entries: LogEntry[] } | null {
    const stored = this.agents.get(agentId);
    if (!stored) return null;
    let entries = stored.log;
    if (typeof since === 'number' && Number.isFinite(since)) {
      entries = entries.filter((e) => e.ts > since);
    }
    // Shallow copy para evitar que el caller mute el ringbuffer
    // interno (los LogEntry son objetos simples sin nesting).
    return { entries: entries.slice() };
  }

  /**
   * Emite el ringbuffer completo de logs de un agente como un único
   * `agent_log_history`. Llamado on-demand cuando el detail panel
   * (editor tab) se monta y necesita hidratar el LogStream con todo
   * el histórico antes de empezar a appendear entries nuevos del
   * canal `agent_log`.
   *
   * Por qué un solo evento batch en vez de re-emitir N×`agent_log`:
   *   Un agente con 1000 entries dispararía 1000 round-trips
   *   postMessage entre extension host y webview, cada uno
   *   serializa + cruza el IPC. Con el batch, es un solo cruce.
   *
   * Si el webview que pidió la hidratación se conoce (por ej. el
   * `onDidReceiveMessage` de un panel sabe su propio webview), se
   * pasa como `targetWebview` y el evento va SOLO a ese. Sin el
   * target, broadcast a todos los webviews — patrón fallback.
   * El target evita serializar 1000 entries para el sidebar que no
   * los usa.
   *
   * No-op silencioso si el agentId no existe (el panel del webview
   * puede haber sido abierto contra un agente que ya fue evictado
   * por TTL). En ese caso emitimos `entries: []` para que el panel
   * pueda mostrar empty state coherente.
   */
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
   * Suscripción al cambio de cantidad de agentes en estado
   * `running`. El status bar item se actualiza con cada delta. El
   * callback recibe el count actual y se invoca SYNC tras cada
   * mutación que pudo cambiarlo (spawn, status_changed terminal,
   * cancel, hydrate). El bridge no batchea — varios deltas en el
   * mismo tick disparan el callback varias veces; el StatusBar
   * filtra duplicados a nivel de su propio render.
   */
  onRunningCountChange(cb: (count: number) => void): () => void {
    this.runningCountListeners.push(cb);
    // Emitimos el count actual al suscribirse para que el StatusBar
    // se pinte coherente sin esperar al primer cambio.
    cb(this.getRunningCount());
    return () => {
      const i = this.runningCountListeners.indexOf(cb);
      if (i >= 0) this.runningCountListeners.splice(i, 1);
    };
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
    if (this.runningCountListeners.length === 0) return;
    const count = this.getRunningCount();
    for (const cb of this.runningCountListeners) {
      try {
        cb(count);
      } catch (err) {
        this.channel.appendLine(
          `[${ts()}] [bridge] running-count listener error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Suscripción a "agente entró en estado terminal". El listener
   * recibe `{agentId, name, status, durationMs, tokensUsed,
   * reason?}` exactamente UNA vez por agente, justo después de que
   * el bridge mutó el snapshot al estado terminal. El CompletionNotifier
   * lo usa para mostrar el toast VS Code; otros consumidores
   * podrían loggear analytics, sound alerts, etc.
   *
   * No re-emite eventos pasados al suscribirse (vs onRunningCountChange
   * que sí emite el count actual). Si el caller quiere el historial,
   * debe usar `listAgents()` + filtrar por status terminal.
   */
  onAgentCompleted(cb: (event: AgentCompletionEvent) => void): () => void {
    this.completionListeners.push(cb);
    return () => {
      const i = this.completionListeners.indexOf(cb);
      if (i >= 0) this.completionListeners.splice(i, 1);
    };
  }

  private notifyCompletion(event: AgentCompletionEvent): void {
    if (this.completionListeners.length === 0) return;
    for (const cb of this.completionListeners) {
      try {
        cb(event);
      } catch (err) {
        this.channel.appendLine(
          `[${ts()}] [bridge] completion listener error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ====================================================================
  // === Runner integration =============================================
  // ====================================================================

  /**
   * Ejecuta el agente y traduce AgentEvent (runtime) →
   * DashboardEventToWebview (wire). Acumula tokens, contextUsedPct,
   * currentTool a lo largo del stream y los emite via
   * agent_status_changed con metadata parcial.
   */
  private async run(
    agentId: string,
    input: SpawnInput,
    signal: AbortSignal,
  ): Promise<void> {
    // Accumuladores de stream. Cada vez que cambian, emitimos
    // status_changed con el subset cambiado (no toda la snapshot).
    let lastTool: string | undefined;
    let lastSubtitle: string | undefined;
    let lastTokensUsed = 0;
    let lastContextTokens = 0;
    let lastContextPct = 0;

    try {
      const result = await this.runner.startAgent({
        prompt: input.prompt,
        cwd: input.cwd,
        model: input.model,
        abortSignal: signal,
        onEvent: (event) => {
          // Log al OutputChannel para diagnóstico (igual que MCP/palette ya hacían).
          logAgentEvent(this.channel, event);

          // === Traducción a LogEntry + posibles metadata updates ===
          const entry = translateToLogEntry(event);
          if (entry) {
            this.appendLog(agentId, entry);
          }

          // status crudo del runtime → wire status + agent_status_changed
          // sin metadata. El terminal status (completed/failed/cancelled)
          // se reemite en run() después del await con duración + tokens.
          if (event.type === 'status') {
            // Solo reemitimos 'running' acá; los terminales los maneja
            // el wrapper de abajo cuando tengamos durationMs definitivo.
            if (event.status === 'running') {
              this.emitStatusChange(agentId, 'running');
            }
            return;
          }

          if (event.type === 'tool_use') {
            lastTool = event.name;
            lastSubtitle = subtitleFromToolInput(event.name, event.input);
            this.emitStatusChange(agentId, 'running', {
              currentTool: lastTool,
              subtitle: lastSubtitle,
            });
            return;
          }

          if (event.type === 'usage') {
            // `tokensUsed` (UI badge en RECENT + completion toast)
            // = costo billable del turno = input nuevo + output. NO
            // incluye cache porque cache reads se pagan a tarifa
            // reducida y la UI muestra "lo que consumiste de nuevo".
            lastTokensUsed = event.inputTokens + event.outputTokens;

            // `contextTokens` (numerador de la barra) y
            // `contextUsedPct` (porcentaje) miden cuánto del
            // context window de 200k está cargado AHORA. El SDK
            // reporta `input_tokens` como solo el delta nuevo del
            // turn; el contexto histórico viaja por cache. Suma:
            //   input_tokens         (delta nuevo del turn)
            //   cache_read_tokens    (contexto previo leído del cache)
            //   cache_creation_tokens (contexto nuevo escrito al cache)
            // Sin sumar los dos cache campos, la ContextBar queda
            // en ~0% durante el run porque casi todo es cache.
            //
            // Mantenemos `tokensUsed` y `contextTokens` como dos
            // campos distintos para que la fracción visible de la
            // barra (`contextTokens / 200k`) sea coherente con el
            // porcentaje. Mezclar ambos como antes daba `0k / 200k
            // · 60%` — matemáticamente incoherente.
            lastContextTokens =
              event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens;
            lastContextPct = Math.min(
              100,
              Math.round((lastContextTokens / CONTEXT_WINDOW_TOKENS) * 100),
            );
            this.emitStatusChange(agentId, 'running', {
              tokensUsed: lastTokensUsed,
              contextTokens: lastContextTokens,
              contextUsedPct: lastContextPct,
            });
            return;
          }

          if (event.type === 'session_id') {
            // Llega UNA vez por agente (primer message del SDK).
            // Lo guardamos en el snapshot del registry y emitimos un
            // status_changed con metadata para que el webview lo
            // settee sin esperar al terminal. El botón Open de la
            // card lo necesita mientras el agente todavía corre.
            this.emitStatusChange(agentId, 'running', {
              sessionId: event.sessionId,
            });
            return;
          }

          if (event.type === 'model') {
            // Llega UNA vez por agente, junto al `system.init`. El
            // SDK puede resolver `'sonnet'` (alias) a un id largo
            // tipo `claude-sonnet-4-5-20251022`. Formateamos a label
            // con versión ("Sonnet 4.5") para el badge de la card.
            this.emitStatusChange(agentId, 'running', {
              model: prettyModel(event.name),
            });
            return;
          }
        },
      });

      // === Terminal ===
      // Calculamos elapsed/duration en wall-clock acá (no en el
      // runner) para que el snapshot que persistimos lleve el
      // valor definitivo coherente con el completedAtIso.
      const completedAtIso = new Date().toISOString();
      const wireStatus = runtimeToWireStatus(result.status);
      const stored = this.agents.get(agentId);
      if (stored) {
        stored.snapshot.status = wireStatus;
        stored.snapshot.completedAtIso = completedAtIso;
        stored.snapshot.durationMs = result.durationMs;
        stored.snapshot.tokensUsed = lastTokensUsed || result.inputTokens + result.outputTokens;
        stored.snapshot.contextTokens = lastContextTokens;
        stored.snapshot.contextUsedPct = lastContextPct;
        stored.snapshot.currentTool = lastTool;
        stored.snapshot.subtitle = lastSubtitle;
        if (wireStatus !== 'done' && result.finalResponse) {
          stored.snapshot.reason = result.finalResponse;
        }
      }

      const completedResult: AgentCompletedResult = {
        status: wireStatus as AgentCompletedResult['status'],
        durationMs: result.durationMs,
        tokensUsed: lastTokensUsed || result.inputTokens + result.outputTokens,
        reason: stored?.snapshot.reason,
      };
      this.post({ type: 'agent_completed', agentId, result: completedResult });

      // Notificamos a los listeners post-completion (toast VS Code,
      // analytics futura). El payload se arma con el state ya mutado
      // arriba; en caso de que stored sea undefined (improbable —
      // si llegamos al bloque terminal el agentId existe en agents),
      // omitimos la notificación.
      if (stored && (wireStatus === 'done' || wireStatus === 'failed' || wireStatus === 'cancelled')) {
        this.notifyCompletion({
          agentId,
          name: stored.snapshot.name,
          status: wireStatus,
          durationMs: result.durationMs,
          tokensUsed: completedResult.tokensUsed,
          reason: stored.snapshot.reason,
        });
      }
    } finally {
      this.aborts.delete(agentId);
      this.schedulePersist();
      // El agente acaba de transicionar running → done/failed/cancelled.
      // El bloque terminal mutó `stored.snapshot.status` directo (sin
      // pasar por `emitStatusChange`), así que el notifyRunningCount
      // que ESO dispararía no corrió. Lo lanzamos acá para que el
      // status bar baje el count al cierre.
      this.notifyRunningCount();
    }
  }

  // ====================================================================
  // === Emisión de eventos =============================================
  // ====================================================================

  private emitStatusChange(
    agentId: string,
    status: AgentStatus,
    metadata?: Partial<AgentSnapshot>,
  ): void {
    // Reflejamos el cambio en el registry local antes de emitir
    // para que un attach posterior vea ya el state actualizado.
    const stored = this.agents.get(agentId);
    if (stored) {
      // Invariante "una vez terminal, no se vuelve a running": si
      // un AgentEvent llega tarde (race entre el bloque terminal
      // del run() y los últimos eventos del SDK), no degradamos
      // el status. Igual mergeamos metadata útil (sessionId/model)
      // — eso sí mantiene info válida.
      const isTerminal =
        stored.snapshot.status === 'done' ||
        stored.snapshot.status === 'failed' ||
        stored.snapshot.status === 'cancelled';
      if (!isTerminal) {
        stored.snapshot.status = status;
      }
      if (metadata) {
        Object.assign(stored.snapshot, metadata);
      }
    }
    this.post({ type: 'agent_status_changed', agentId, status, metadata });
    this.schedulePersist();
    // NO notificamos count acá: por contrato hoy todos los call
    // sites de emitStatusChange pasan status='running' (cambios de
    // metadata mid-run). El terminal lo notifica el `finally` de
    // run() después de mutar el snapshot directo. Sin esto, cada
    // tool_use/usage spawnaba un getRunningCount() + listener loop
    // sin que el count realmente cambiara.
  }

  /**
   * Append a log + emitir agent_log al webview. El ringbuffer se
   * mantiene en `stored.log` (per-agent, FIFO bounded).
   */
  private appendLog(agentId: string, entry: LogEntry): void {
    const stored = this.agents.get(agentId);
    if (stored) {
      stored.log.push(entry);
      if (stored.log.length > LOG_RING_MAX) {
        // shift es O(n) pero con N=1000 el costo es trivial (~µs).
        // Si esto se vuelve hot path se cambia a un ring real con
        // head/tail indices.
        stored.log.shift();
      }
    }
    this.post({ type: 'agent_log', agentId, entry });
    // Log entries cambian rápido — solo persistimos cada N
    // entries o cuando cambia status. Para evitar contar acá,
    // dejamos el debounce de schedulePersist (500ms) que ya colapsa.
    this.schedulePersist();
  }

  /**
   * Broadcast a TODOS los webviews attached. Si no hay ninguno, el
   * evento se descarta (no hay queue interna). postMessage es
   * fire-and-forget; si un webview murió en medio del frame, VS Code
   * lo absorbe sin tirar.
   */
  private post(event: DashboardEventToWebview): void {
    for (const w of this.webviews) {
      w.postMessage(event);
    }
  }

  /**
   * Entry point público para que controladores externos (ej. el
   * scanner) publiquen eventos al webview sin tocar la referencia
   * privada `this.webview`. Mismo fire-and-forget que el post
   * interno: si no hay webview attached, el evento se descarta.
   */
  emit(event: DashboardEventToWebview): void {
    this.post(event);
  }

  // ====================================================================
  // === Persistencia ====================================================
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
    // Capturamos el snapshot SYNC antes del await. Sin esto, dos
    // flushes solapados podrían terminar fuera de orden y dejar
    // un snapshot más viejo encima del más nuevo. Tomar el array
    // de inmediato fija el state del momento exacto del flush
    // que pidió disparar este write.
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
    // Cancelamos cualquier agente activo: la EDH se está apagando.
    // Sus subprocess se llevarán "cancelled" como status.
    this.cancelAll();

    // Esperamos a que cada run() resuelva su bloque terminal
    // (status='cancelled' + completedAtIso) antes del flush final.
    // Sin este await el flush captura el state PRE-cancelado y al
    // próximo activate quedan como huérfanos (running→failed
    // con razón ide_restart) en vez de cancelled limpio.
    if (this.activeRuns.size > 0) {
      await Promise.allSettled([...this.activeRuns]);
    }

    // Si hay un flush pendiente lo ejecutamos ahora — perder la
    // última hornada de cambios deja datos inconsistentes en el
    // próximo activate.
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
    // Spread copy: el webview no debe ver mutaciones del registry
    // interno. Shallow es suficiente porque AgentSnapshot es plano
    // (todos los campos son primitivos / strings / numbers).
    return Array.from(this.agents.values()).map((s) => ({ ...s.snapshot }));
  }

  private makeAgentId(): string {
    return crypto.randomUUID();
  }

  private getProjectsRoot(): string[] {
    const cfg = vscode.workspace.getConfiguration('claudeOrchestrator');
    const raw = cfg.get<string[]>('projectsRoot', []);
    // Expandir ~ y normalizar; usuarios pueden poner "~/git19/docs".
    return raw.map((p) => expandUserHome(p));
  }

  /**
   * Lee `claudeOrchestrator.defaultModel` con guard a `DEFAULT_MODEL`.
   * Aplica cuando el caller del bridge (palette command o MCP) NO
   * especifica un modelo explícito en `SpawnInput.model`.
   *
   * El setting está restringido a `MODEL_ALIASES` por el enum del
   * schema, pero un user puede haber guardado un valor obsoleto
   * (ej. alias renombrado en una versión futura del SDK). El guard
   * defensivo evita que un setting basura le rompa el spawn.
   */
  private getDefaultModel(): ModelAlias {
    const cfg = vscode.workspace.getConfiguration('claudeOrchestrator');
    const raw = cfg.get<string>('defaultModel', DEFAULT_MODEL);
    return (MODEL_ALIASES as readonly string[]).includes(raw)
      ? (raw as ModelAlias)
      : DEFAULT_MODEL;
  }
}

// ====================================================================
// === Helpers de módulo (exportables para tests futuros) =============
// ====================================================================

/**
 * Convierte el id de modelo crudo del SDK a un label legible para
 * el ModelBadge de la card. Reconoce:
 *
 *   - id largo `claude-<family>-<major>-<minor>(-<sufijo>)?` →
 *     `<Family> <major>.<minor>` (ej. "Sonnet 4.5", "Opus 4.7").
 *     `family` acepta cualquier slug de letras + guiones, así que
 *     una familia futura ("claude-something-1-0-20300101") cae al
 *     mismo formato en vez de quedar como id raw.
 *   - alias corto sin guiones → capitalizado sin versión.
 *   - cualquier otro string → se devuelve tal cual.
 *
 * Charset assumption: los ids del SDK usan letras y guiones (`-`).
 * Si Anthropic introduce underscore (`_`) o digits en family, este
 * regex no lo matchea y caemos al fallback `return raw`. No es
 * blocker (el badge muestra el id), pero conviene ampliar charset
 * cuando aparezca un caso real.
 *
 * Exportable y puro para tests sin filesystem ni network.
 */
export function prettyModel(raw: string): string {
  if (!raw) return '';
  // Id largo: `claude-<family>-<major>-<minor>(-<sufijo>)?`. El
  // family slug es greedy hasta dos números consecutivos separados
  // por guion (`<major>-<minor>`); el resto del string (fecha o
  // tag) lo descartamos.
  const long = /^claude-([a-z][a-z-]*?)-(\d+)-(\d+)(?:-.*)?$/i.exec(raw);
  if (long) {
    return `${capitalize(long[1])} ${long[2]}.${long[3]}`;
  }
  // Alias corto: una palabra de letras, sin guiones ni dígitos.
  if (/^[a-z]+$/i.test(raw)) {
    return capitalize(raw);
  }
  return raw;
}

/**
 * Mapea el AgentStatus del runtime al del wire UI.
 * Runtime usa 'completed'; el wire/UI usa 'done' por consistencia
 * con el wireframe del brief (RECENT muestra "✓ done").
 */
export function runtimeToWireStatus(s: RuntimeAgentStatus): AgentStatus {
  switch (s) {
    case 'running':
      return 'running';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default: {
      // Forward-compat: status nuevo del runtime → fallback failed.
      const _exhaustive: never = s;
      void _exhaustive;
      return 'failed';
    }
  }
}

/**
 * Deriva (project, task, branch) del cwd siguiendo §9.2 del brief.
 *
 *   1. options.project explícito gana.
 *   2. cwd matchea `<root>/<project>/...` para algún root → ese segmento.
 *   3. cwd matchea workspace folder → basename del folder.
 *   4. fallback basename(cwd).
 *
 * `task` solo cubre la convención `<root>/<project>/tasks/<task>/...`
 * (el caso 1 del brief §9.3). La heurística alternativa de "primer
 * subfolder sin nivel `tasks/`" se descarta deliberadamente: infiere
 * tasks falsos en estructuras planas de repos no-Trescloud. Sin
 * match, `task = ''` y la UI muestra el fallback (línea solo con
 * branch).
 *
 * `branch` vía `git -C <cwd> branch --show-current` sync. Si el cwd
 * no es git repo, cadena vacía. Sync porque el costo es ~10-30ms y
 * facilita razonamiento: el snapshot inicial ya viene completo.
 *
 * Exportable y puro a propósito — testeable con casos sintéticos
 * sin necesidad de filesystem.
 */
export function deriveProjectContext(
  cwd: string,
  projectsRoot: string[],
  override?: string,
  workspaceFolders?: readonly string[],
): { project: string; task: string; branch: string } {
  const { project, task } = deriveProjectContextPure(
    cwd,
    projectsRoot,
    override,
    workspaceFolders,
  );
  const branch = readGitBranch(cwd);
  return { project, task, branch };
}

/**
 * Variante 100% pura de `deriveProjectContext`: NO ejecuta `git`.
 *
 * Hot path del session scanner — clasifica cada uno de los ~260
 * `.jsonl` históricos por proyecto. Si reusáramos la versión con
 * git, harían N forks de `git branch` síncronos en el event loop
 * del extension host por cada scan (cada 60s con auto-refresh
 * default), congelando VS Code varios segundos.
 *
 * El scanner además ya tiene el `gitBranch` autoritativo dentro
 * del propio JSONL — no necesita re-calcularlo del filesystem.
 *
 * Acepta `firstUserPrompt` opcional para activar la heurística de
 * derivación desde el contenido del prompt: el cwd del JSONL viene
 * del workspace folder de VS Code, no de la subcarpeta donde está
 * la tarea. Si el prompt menciona un path absoluto dentro de un
 * projectsRoot, ese path es mejor señal que el cwd genérico.
 */
export function deriveProjectContextPure(
  cwd: string,
  projectsRoot: string[],
  override?: string,
  workspaceFolders?: readonly string[],
  firstUserPrompt?: string,
  signalText?: string,
): { project: string; task: string } {
  const normCwd = normalizePath(cwd);
  let project = '';
  let task = '';

  if (override) {
    project = override;
  } else {
    // === Paso 1: match cwd contra projectsRoot ===
    // Caso ideal — workspace = ~/git19/docs/proj/. El user lo controla
    // explícito y es prioridad sobre todo lo demás.
    for (const root of projectsRoot) {
      const normRoot = normalizePath(root);
      if (isSubPath(normCwd, normRoot)) {
        const rel = normCwd.slice(normRoot.length + 1);
        const segments = rel.split('/');
        if (segments[0]) {
          project = segments[0];
          if (segments[1] === 'tasks' && segments[2]) {
            task = segments[2];
          }
        }
        break;
      }
    }

    // === Paso 2: heurística del prompt ===
    // ANTES que workspace folders porque el prompt apunta a un
    // subpath específico (proyecto/tarea real) mientras que el
    // workspace folder es típicamente un parent genérico (~/git19/).
    // Ejemplo del bug que dispara este orden: workspace=~/git18,
    // cwd=/home/trescloud/git18, prompts mencionan
    // docs/ecuadorian-hr18/... → queremos `ecuadorian-hr18`, NO
    // `git18` (basename del workspace).
    if (!project && projectsRoot.length > 0) {
      const haystack = [firstUserPrompt, signalText]
        .filter(Boolean)
        .join('\n');
      if (haystack) {
        const fromPrompt = derivePathFromPrompt(haystack, projectsRoot, normCwd);
        if (fromPrompt) {
          project = fromPrompt.project;
          task = fromPrompt.task;
        }
      }
    }

    // === Paso 3: match cwd contra workspace folders ===
    // Fallback genérico cuando el prompt no aportó señal. Pasa con
    // sesiones que no mencionan paths específicos en ningún user
    // prompt ni en tool_use.
    if (!project) {
      const folders = workspaceFolders ?? readWorkspaceFolders();
      for (const folder of folders) {
        const normFolder = normalizePath(folder);
        if (normCwd === normFolder || isSubPath(normCwd, normFolder)) {
          project = path.basename(normFolder);
          break;
        }
      }
    }

    // === Paso 4: fallback final ===
    if (!project) {
      project = path.basename(normCwd) || normCwd;
    }
  }

  return { project, task };
}

/**
 * Busca el primer path en `prompt` que matchee algún `projectsRoot`
 * y devuelve `{project, task}` derivados. Acepta:
 *
 *   - Paths absolutos: `/home/user/git19/docs/proj/file.py`.
 *   - Paths relativos (si `baseCwd` se pasa): `docs/proj/file.py`
 *     resuelve contra baseCwd → matchea projectsRoot. Esto cubre
 *     el caso "tool_use file_path=docs/x/y.py" cuando Claude
 *     trabaja desde el workspace folder.
 *
 * Regex conservador: solo letras, números, `._-` en cada segmento,
 * mínimo 2 segmentos. Excluye URLs y paths con espacios.
 *
 * Exportable para tests; null si no encuentra match.
 */
export function derivePathFromPrompt(
  prompt: string,
  projectsRoot: string[],
  baseCwd?: string,
): { project: string; task: string } | null {
  // Path absoluto: `/foo/bar/baz`. Lookbehind para evitar matchear
  // "//comentarios" o "http://...".
  const ABS_PATH_REGEX = /(?:^|[\s(`"'])(\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)/g;
  // Path relativo: `foo/bar/baz` (mínimo 2 segmentos, no precedido
  // de `/` o letras — esto excluye paths absolutos y URLs como
  // "github.com/user/repo"). Usado solo cuando baseCwd está
  // disponible para resolverlos.
  const REL_PATH_REGEX =
    /(?:^|[\s(`"'])((?:[A-Za-z0-9._-]+\/){1,}[A-Za-z0-9._-]+)/g;

  const normRoots = projectsRoot.map((r) => normalizePath(r));

  // Helper: intenta matchear un path canonicalizado contra los roots.
  function tryMatch(candidate: string): { project: string; task: string } | null {
    for (const root of normRoots) {
      if (isSubPath(candidate, root)) {
        const rel = candidate.slice(root.length + 1);
        const segments = rel.split('/');
        if (segments[0]) {
          const project = segments[0];
          let task = '';
          if (segments[1] === 'tasks' && segments[2]) {
            task = segments[2];
          }
          return { project, task };
        }
      }
    }
    return null;
  }

  // === Pass 1: paths absolutos ===
  let m: RegExpExecArray | null;
  while ((m = ABS_PATH_REGEX.exec(prompt)) !== null) {
    const matched = tryMatch(normalizePath(m[1]));
    if (matched) return matched;
  }

  // === Pass 2: paths relativos resueltos contra baseCwd ===
  // Solo si tenemos baseCwd (el cwd del .jsonl) — sin él no podemos
  // resolver. Esto captura "file_path: docs/equipo-ya/foo.py" en
  // tool_use de Claude cuando estaba en /home/trescloud/git19.
  if (baseCwd) {
    const normBase = normalizePath(baseCwd);
    while ((m = REL_PATH_REGEX.exec(prompt)) !== null) {
      const raw = m[1];
      // Skip si arranca con segmento conocido como URL ("https",
      // "http", "ftp") o esquema con dos puntos.
      if (/^(https?|ftp|file|git):/i.test(raw)) continue;
      // Skip si parece dominio (ej. "github.com/user/repo") — un
      // primer segmento con punto y todo letras suele ser host.
      const firstSeg = raw.split('/')[0];
      if (/\./.test(firstSeg) && /^[a-z0-9.-]+$/i.test(firstSeg)) continue;
      const resolved = normalizePath(path.join(normBase, raw));
      const matched = tryMatch(resolved);
      if (matched) return matched;
    }
  }
  return null;
}

/**
 * Traduce un AgentEvent del runtime a un LogEntry del wire.
 * Devuelve null para eventos que no queremos persistir (los
 * 'status' los manejamos aparte como agent_status_changed).
 */
function translateToLogEntry(event: AgentEvent): LogEntry | null {
  const tsMs = Date.now();
  switch (event.type) {
    case 'thinking':
      return { ts: tsMs, kind: 'thinking', text: event.text };
    case 'text':
      return { ts: tsMs, kind: 'text', text: event.text };
    case 'tool_use':
      return { ts: tsMs, kind: 'tool_use', name: event.name, input: event.input };
    case 'tool_result':
      return {
        ts: tsMs,
        kind: 'tool_result',
        toolUseId: event.toolUseId,
        result: event.result,
        isError: event.isError,
      };
    case 'usage':
      return {
        ts: tsMs,
        kind: 'usage',
        tokensUsed: event.inputTokens + event.outputTokens,
      };
    case 'status':
      // Los status changes los emitimos como agent_status_changed
      // (canal específico para que la UI no tenga que filtrar).
      return null;
    case 'session_id':
      // Identidad de la sesión; no es contenido de log. Va al
      // snapshot via agent_status_changed (ver onEvent del run).
      return null;
    case 'model':
      // Modelo resuelto por el SDK; va al snapshot via
      // agent_status_changed, no al log streaming.
      return null;
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Heurística simple para sacar un subtítulo human-friendly del
 * input de un tool. Edit/Write/Read típicamente traen file_path;
 * Bash trae command; Glob/Grep traen pattern. Sin acceso al
 * schema oficial de cada tool, miramos las keys frecuentes en
 * orden y truncamos.
 */
function subtitleFromToolInput(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  // Orden de preferencia: campos más informativos primero.
  // Cubre Read/Edit/Write (`file_path`), Glob/Grep (`pattern`),
  // WebSearch (`query`), Bash (`command`), NotebookEdit
  // (`notebook_path`), WebFetch (`url`), genéricos (`description`).
  const keys = [
    'file_path',
    'notebook_path',
    'path',
    'pattern',
    'query',
    'command',
    'url',
    'description',
  ];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) {
      return truncateMiddle(v, 60);
    }
  }
  return toolName;
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return s.slice(0, half) + '…' + s.slice(s.length - half);
}

function normalizePath(p: string): string {
  // path.resolve normaliza separadores + resuelve .. — suficiente
  // para nuestros matches. NO resolvemos symlinks (realpath) porque
  // el user que setea projectsRoot generalmente apunta al path
  // canónico que él tipea.
  return path.resolve(expandUserHome(p));
}

function isSubPath(child: string, parent: string): boolean {
  return child.startsWith(parent + '/') || child === parent;
}

function expandUserHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    const home = process.env.HOME ?? '';
    return p === '~' ? home : path.join(home, p.slice(2));
  }
  return p;
}

function readWorkspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((w) => w.uri.fsPath);
}

function readGitBranch(cwd: string): string {
  try {
    const out = childProcess.execFileSync(
      'git',
      ['-C', cwd, 'branch', '--show-current'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      },
    );
    return out.trim();
  } catch {
    // No es git repo / git no instalado / cwd inexistente — fallback vacío.
    return '';
  }
}
