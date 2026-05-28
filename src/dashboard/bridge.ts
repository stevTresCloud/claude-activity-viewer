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

/**
 * Wrapper async manual sobre `child_process.execFile`. No usamos
 * `util.promisify` porque depende del símbolo `util.promisify.custom`
 * que Node attacha a la función real — los mocks de tests no lo tienen
 * y la promisify genérica resuelve a `stdout` directo (no
 * `{stdout, stderr}`), divergiendo entre prod y test. Este wrapper
 * normaliza ambos paths: resuelve a `string` (stdout) o rechaza con
 * Error. Lo usa captureCriticDiff para que sus N llamadas dentro del
 * Promise.all en runCriticsForBatch NO se serialicen por block del
 * event loop.
 */
function execFileAsync(
  cmd: string,
  args: string[],
  opts: { encoding: 'utf-8'; timeout?: number; maxBuffer?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(cmd, args, opts, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}
import * as vscode from 'vscode';
import type { AgentRunner } from '../runtime/agent-runner';
import {
  DEFAULT_MODEL,
  MODEL_ALIASES,
  type AgentEvent,
  type AgentStatus as RuntimeAgentStatus,
  type ModelAlias,
} from '../runtime/types';
import {
  CRITIC_DIFF_MAX_BYTES,
  CRITIC_TOOL_ALLOWLIST,
  buildCriticPrompt,
  buildExitSchemaInstruction,
  parseCriticOutput,
  parseExitSchema,
  type CriticFinding as RuntimeCriticFinding,
  type ExitReport as RuntimeExitReport,
} from '../runtime/exit-schema';
import { logAgentEvent, ts } from '../runtime/log';
import { capitalize, secondsToMs } from '../shared/format';
import {
  LOG_RING_MAX,
  isTerminalStatus,
  type AgentCompletedResult,
  type AgentSnapshot,
  type AgentStatus,
  type CriticFinding,
  type DashboardEventToWebview,
  type ExitReport,
  type LogEntry,
  type TransportState,
  type VerificationReport,
  type WaitForAgentsAgentPending,
  type WaitForAgentsAgentResult,
  type WaitForAgentsResult,
} from '../shared/dashboard-protocol';

// === Constantes ===

const STATE_KEY = 'claudeOrchestrator.agents';
// LOG_RING_MAX vive en shared/dashboard-protocol.ts — bridge y store
// del webview lo respetan en paralelo (importan desde el mismo lugar).
const TTL_MS = 30 * 24 * 60 * 60 * 1000;       // 30 días
const PERSIST_DEBOUNCE_MS = 500;
/**
 * Idempotency cache de `wait_for_agents`: si una segunda call llega con
 * el mismo set de `agentIds` mientras el primer waiter sigue activo, se
 * suscribe a la MISMA Promise (fan-in) en vez de crear un waiter nuevo.
 *
 * Caso de uso: el transport MCP tira mid-call (issue conocido en
 * claude-code 2.1.x con long-polls; ver V0_1_0_FIELD_REPORT.md). El
 * modelo re-invoca con los mismos ids y recoge el waiter en lugar de
 * reiniciarlo desde cero.
 *
 * TTL = 30 min: cap arriba del max timeout_sec (1200s = 20 min). Si por
 * algún motivo el waiter nunca resuelve, el TTL evita leak del map.
 * Cache size LRU = 32: límite defensivo contra crecimiento patológico
 * en sesiones muy largas (eviction FIFO del más viejo).
 */
const WAITER_TTL_MS = 30 * 60 * 1000;
const WAITER_CACHE_MAX = 32;
/**
 * Umbral del transport degraded: si un `wait_for_agents` lleva más de
 * esto sin resolver, sospechamos que el transport HTTP cayó (los
 * agentes pueden seguir corriendo bien — el bridge no los pierde —
 * pero el chat caller nunca recibió la respuesta del long-poll).
 *
 * 60s es el techo observado en el field report v0.1.0: los 3 drops
 * documentados ocurrieron < 60s desde spawn. Sobre los waiters legítimos
 * tendría que ser configurable; por ahora hardcoded — la UI gates con
 * setting opt-in (`claudeOrchestrator.showTransportState`).
 */
const TRANSPORT_DEGRADED_THRESHOLD_MS = 60 * 1000;

// === Verification (Mecanismo D + A) ===

/**
 * Modos del setting `claudeOrchestrator.verification`. SSoT de los
 * valores aceptados: cualquier otro string del setting cae al default
 * 'structured' vía guard defensivo en `getVerificationMode`.
 *
 * Mapeo conceptual (ver research/VERIFICATION_MECHANISMS.md §3-5):
 *   - 'none':         comportamiento legacy, sin parseo ni critic.
 *   - 'structured':   solo D. Costo runtime cero — añade párrafo al
 *                     prompt + parse del exit JSON al cierre.
 *   - 'critic':       solo A. Critic Haiku revisa el diff, sin D.
 *   - 'both':         D + A activos.
 *   - 'human-review': D + A + (futuro) panel modal para approve/reject.
 *                     Hoy equivale a 'both' — el panel queda para v0.2.1+.
 */
const VERIFICATION_MODES = ['none', 'structured', 'critic', 'both', 'human-review'] as const;
type VerificationMode = (typeof VERIFICATION_MODES)[number];
const DEFAULT_VERIFICATION_MODE: VerificationMode = 'structured';

/**
 * Timeout para cada critic Haiku. Si Haiku no termina en este budget,
 * abortamos y guardamos un flag artificial 'critic_timeout' en findings.
 * 90s es generoso: un Haiku revisando un diff de <500 KB típicamente
 * tarda 15-40s. Más allá indica que el modelo se colgó o la red murió.
 */
const CRITIC_TIMEOUT_MS = 90 * 1000;

/**
 * ¿La modalidad invoca al critic Haiku? D-only ('structured') no lo
 * invoca; los demás sí (incluso 'human-review' porque el critic alimenta
 * el panel modal futuro).
 */
function modeNeedsCritic(mode: VerificationMode): boolean {
  return mode === 'critic' || mode === 'both' || mode === 'human-review';
}

/**
 * ¿La modalidad incluye el parseo del exit estructurado? Todas menos
 * 'none' y 'critic'. Decisión: en 'critic' puro NO parseamos porque
 * el setting indica "no quiero el shape estructurado, solo verificación
 * post-hoc del diff" — agregar el briefing del exit sería ruido extra
 * en el prompt sin ganancia.
 */
function modeNeedsExitSchema(mode: VerificationMode): boolean {
  return mode === 'structured' || mode === 'both' || mode === 'human-review';
}

/**
 * Key estable para el idempotency cache: orden no importa al chat caller
 * (mismo set de agent_ids = misma intent), así que ordenamos y juntamos.
 * UUIDs tienen ~122 bits de entropía — la chance de colisión es nula sin
 * hashing extra. Si en v0.3 cambia el formato del id (p. ej. ULID), revisar.
 */
function waiterKey(agentIds: string[]): string {
  return [...agentIds].sort().join(',');
}
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
  /**
   * Último text block que el agente emitió. Se actualiza con cada
   * evento `type: 'text'` del runner. Para agentes `done` típicamente
   * queda el mensaje de cierre. Para `cancelled`/`failed`, queda el
   * último progreso ANTES del corte — NO incluye el `finalResponse`
   * sintético del runner ("User cancelled", error trace) que viene
   * por otro path. Decisión deliberada: el último avance del agente
   * es más útil para el chat externo que el string de control.
   *
   * Mid-run sirve como `last_message_partial` para `wait_for_agents`:
   * el chat externo ve qué está diciendo el agente sin tener que
   * pollear el log completo.
   *
   * Vive fuera del wire AgentSnapshot porque la UI del sidebar no
   * lo renderiza (los logs van por evento separado al webview).
   * Solo el handler MCP lo consume vía registry.
   */
  lastAssistantMessage?: string;
  /**
   * Epoch ms del último evento que el bridge procesó para este
   * agente. Se updatea con CUALQUIER tipo de evento (thinking, text,
   * tool_use, tool_result, usage, status, session_id, model). Lo usa
   * `wait_for_agents` para detectar agentes posiblemente pegados —
   * si `now - lastActivityAt > stuckDetectionSec`, se marca
   * `suspected_stuck: true` en la respuesta. NO mata al agente; la
   * decisión de cancelar queda al chat externo.
   */
  lastActivityAt: number;
  /**
   * Epoch ms del arranque del agente. Lo usa el cap defensivo
   * `maxAgentRuntimeSec`: si `now - startedAt > maxRuntimeMs`, el
   * bridge cancela el agente con `reason: 'max_runtime_exceeded'`.
   * Independiente de los listeners de wait_for_agents.
   */
  startedAt: number;

  // === Verification (D + A) — Ticket #1 ===

  /**
   * Modo de verification capturado al spawn. Se lockea acá para que
   * cambios live del setting NO afecten agentes ya corriendo (un
   * agente arrancado con 'both' debe verificarse con 'both' aunque
   * el setting baje a 'none' mid-flight). Undefined en agentes
   * legacy persistidos antes de 0.2.0 — el flujo trata undefined
   * como 'none' (sin verification).
   */
  verificationMode?: VerificationMode;
  /**
   * Snapshot del HEAD git en `cwd` al momento del spawn. Lo usa el
   * critic para computar `git diff <headBefore>..HEAD`. Undefined
   * cuando el cwd no es repo git, git no está instalado, o la
   * versión del bridge persistió antes de 0.2.0.
   */
  headBefore?: string;
  /**
   * Reporte estructurado del agente parseado al cierre. Vacío
   * cuando el modo es 'none'/'critic' o cuando parseExitSchema falló.
   * Vive en el wire `VerificationReport.exit_report`.
   */
  exitReport?: RuntimeExitReport;
  /**
   * Código de razón cuando `parseExitSchema` falló. Stable string para
   * métricas (§8 doc). Empty cuando el parseo fue ok o no se intentó.
   */
  exitParseReason?: string;
  /**
   * Findings del critic Haiku. Vacío cuando el modo no incluye critic
   * o cuando el critic aún no corrió. Una vez seteado, no se vuelve
   * a correr el critic para este agente (idempotencia per-agente).
   */
  criticFindings?: RuntimeCriticFinding[];
  /**
   * Costo billable del critic en USD acumulado. Útil para métricas.
   */
  criticCostUsd?: number;
  /**
   * Duración del critic en ms (wall-clock). Métrica para §8 doc.
   */
  criticDurationMs?: number;
  /**
   * Por qué el bridge promovió el status a 'needs_review'. Strings
   * estables: 'decisions' | 'uncertainties' | 'critic_flags'. Vacío
   * cuando no hubo promoción (status terminal queda como done/failed/cancelled).
   */
  autoPromoteReason?: string;
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
 * Entry del idempotency cache de `wait_for_agents`. Una invocación en vuelo
 * que múltiples calls pueden compartir (fan-in) cuando llegan con el mismo
 * set de agent_ids dentro del TTL.
 */
interface SharedWaiter {
  /** Promise de la respuesta consolidada. Suscribirse = await en este field. */
  promise: Promise<WaitForAgentsResult>;
  /** Epoch ms al crear el waiter. Suma con `WAITER_TTL_MS` da el deadline. */
  createdAt: number;
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

// === Listener helper ===

/**
 * Helper genérico para los 3 arrays de callbacks que mantenía el
 * bridge (`attachCallbacks`, `runningCountListeners`,
 * `completionListeners`). Encapsula el patrón `push + dispose +
 * iterate-with-catch + log` para evitar triplicar la misma lógica.
 *
 * No se exporta: solo lo consume el bridge en este archivo. Si
 * algún día otro módulo lo necesita, se mueve a `src/shared/`.
 *
 * Convención: `T = void` para listeners sin payload (se llama
 * `emit(undefined)`). El compilador acepta `void` como tipo de
 * parámetro y lo trata como `undefined` en runtime.
 */
class Listeners<T> {
  private readonly cbs: Array<(arg: T) => void> = [];

  constructor(
    private readonly channel: vscode.OutputChannel,
    private readonly label: string,
  ) {}

  /**
   * Suscribe un callback. Devuelve la función de des-registro.
   *
   * Semántica del dispose: busca el callback por referencia (`indexOf`)
   * y lo remueve UNA vez. Llamar al dispose dos veces no rompe — la
   * segunda llamada no encuentra el cb (ya removido) y es no-op. Si
   * el mismo `cb` se registró N veces y se llama al dispose una sola
   * vez, queda en el array N-1 instancias del cb.
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
   * ejecute. Los errores se loggean al OutputChannel con el `label`
   * del constructor para correlacionar con el bridge log.
   *
   * Limitación: NO es re-entrant. Si un cb llama a su propio
   * dispose dentro de `emit`, el `splice` muta `this.cbs` durante
   * iteración y el siguiente cb se skipea. Ningún listener actual
   * (attach/running-count/completion) tiene re-entrancy, así que el
   * trade-off entre snapshot `[...this.cbs]` y simplicidad gana la
   * simplicidad. Si se agrega un listener re-entrant, snapshotear.
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
  // Timers del cap defensivo `maxAgentRuntimeSec`. Cada agente
  // arranca con un setTimeout que, si vence antes de la terminación
  // natural, setea `snapshot.reason='max_runtime_exceeded'` directo
  // y llama bridge.cancel. El bloque terminal del run() respeta el
  // reason ya seteado (no lo pisa con el finalResponse del runner).
  private readonly maxRuntimeTimers = new Map<string, NodeJS.Timeout>();

  // Idempotency cache de wait_for_agents: misma key (agentIds sorted) →
  // mismo Promise (fan-in). Sobrevive transport drops mid-call: el modelo
  // re-invoca con los mismos ids y se suscribe al waiter existente.
  // Insertion-order del Map = FIFO para LRU eviction al pasar el cap.
  private readonly waiterCache = new Map<string, SharedWaiter>();

  // Tracking del heurístico transport-degraded por waiter. Una sola
  // estructura encoda los dos estados posibles de un waiter:
  //   - value = NodeJS.Timeout: timer aún corriendo, waiter en
  //     ventana pre-threshold (sano).
  //   - value = null:            timer ya disparó, waiter post-threshold
  //     (degraded). updateTransportState lo refleja.
  // Cleanup en .finally del waiter elimina la entry sea cual sea su
  // estado, y dispara updateTransportState si la transición lo amerita.
  private readonly waiterDegradedState = new Map<string, NodeJS.Timeout | null>();
  private transportState: TransportState = 'healthy';
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
  private readonly attachListeners: Listeners<void>;

  // Listeners del count de agentes running. Lo consume el
  // StatusBar item (extension host). Mantenemos array porque la
  // suscripción/de-suscripción es rara (1 por activación de la
  // extension); no vale la pena un Set.
  private readonly runningCountListeners: Listeners<number>;

  // Listeners de "agente entró en estado terminal". Lo consume el
  // CompletionNotifier (toast VS Code). Mismo patrón que
  // runningCountListeners — 1 listener fijo por activación, array OK.
  private readonly completionListeners: Listeners<AgentCompletionEvent>;

  // Persistencia debounced: cada evento agenda un flush, sucesivos
  // mientras el timer corre se colapsan en uno solo. Sin esto, un
  // agente verboso (cientos de tool_use/sec) generaría N writes
  // por segundo al globalState — fallaría rendimiento de VS Code.
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(options: DashboardBridgeOptions) {
    this.context = options.context;
    this.channel = options.channel;
    this.runner = options.runner;
    this.attachListeners = new Listeners<void>(this.channel, 'attach');
    this.runningCountListeners = new Listeners<number>(
      this.channel,
      'running-count',
    );
    this.completionListeners = new Listeners<AgentCompletionEvent>(
      this.channel,
      'completion',
    );
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

      // === Defaults para campos nuevos ===
      // Snapshots persistidos antes de 1.5.h no tienen lastActivityAt
      // ni startedAt. Defensive defaults: tratarlos como "actividad
      // ahora mismo" (no van a estar running de nuevo después del
      // recovery de huérfanos arriba) — para items en RECENT estos
      // campos no se usan, solo sirven mientras un agente está vivo.
      if (typeof entry.lastActivityAt !== 'number') {
        entry.lastActivityAt = now;
      }
      if (typeof entry.startedAt !== 'number') {
        entry.startedAt = now;
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
    // Re-emitimos el estado actual del transport al webview nuevo. El
    // `transport_state_changed` solo se broadcast en TRANSICIONES; sin
    // este replay, un sidebar abierto durante un drop arrancaría con
    // 'healthy' aunque el bridge ya lo había puesto en 'degraded'.
    webview.postMessage({ type: 'transport_state_changed', state: this.transportState });
    // Notificamos a los suscriptores (scanner-controller) para que
    // re-emitan su último cache al webview. Fire-and-forget; un
    // callback que tire no debe romper attach.
    this.attachListeners.emit(undefined);
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
    return this.attachListeners.add(cb);
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

    // === Verification (Mecanismo D + A) ===
    // Lectura del setting al MOMENTO del spawn — se lockea para este
    // agente para que cambios live del setting no descalcen flow.
    // Captura del HEAD git en cwd para que el critic post-fan-in
    // pueda computar `git diff <headBefore>..HEAD`. Si cwd no es repo,
    // headBefore queda undefined y el critic recibe diff vacío.
    const verificationMode = this.getVerificationMode();
    const headBefore = readGitHead(input.cwd);
    const promptWithExit = modeNeedsExitSchema(verificationMode)
      ? input.prompt + buildExitSchemaInstruction()
      : input.prompt;

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
      // verificationMode lockeado al spawn — sirve para que la card
      // RECENT renderee el VerificationBadge incluso si el setting
      // cambia mid-flight. Omitido del snapshot si mode='none' para
      // que la UI sepa "no había verification activa para este agente"
      // (legacy compat con agentes pre-0.2.0).
      ...(verificationMode !== 'none' ? { verificationMode } : {}),
    };

    const nowMs = Date.now();
    const stored: StoredAgent = {
      snapshot,
      cwd: input.cwd,
      // Guardamos el prompt ORIGINAL (sin el exit instruction). El
      // detail panel y el resume mostraran lo que el caller envió,
      // no la inyección automática del bridge.
      prompt: input.prompt,
      log: [],
      lastActivityAt: nowMs,
      startedAt: nowMs,
      verificationMode,
      headBefore,
    };
    this.agents.set(agentId, stored);

    const abort = new AbortController();
    this.aborts.set(agentId, abort);

    // WHY lectura inline (no en constructor): cada spawn lee el valor
    // vigente del setting. Caveat: si el setting BAJA tras spawn, los
    // agentes ya corriendo respetan el cap original (su timer no se
    // recalcula). Solo el próximo spawn ve el cambio.
    const cfg = vscode.workspace.getConfiguration('claudeOrchestrator');
    const maxRuntimeSec = cfg.get<number>('maxAgentRuntimeSec', 2000);
    const maxRuntimeMs = secondsToMs(Math.max(60, maxRuntimeSec));
    const maxRuntimeTimer = setTimeout(() => {
      this.maxRuntimeTimers.delete(agentId);
      const live = this.agents.get(agentId);
      if (!live || live.snapshot.status !== 'running') return;
      // Race-safe: si alguien (user via cancel_agent, ide_restart, etc.)
      // ya seteó un reason, NO lo pisamos. Ej: user click cancel ~0ms
      // antes de que el timer dispare — el cap encontraría reason
      // ya seteado y respeta la decisión humana.
      if (live.snapshot.reason) return;
      this.channel.appendLine(
        `[${ts()}] [bridge] max_runtime_exceeded id=${agentId} after ${maxRuntimeSec}s — cancelling`,
      );
      live.snapshot.reason = 'max_runtime_exceeded';
      this.cancel(agentId);
    }, maxRuntimeMs);
    this.maxRuntimeTimers.set(agentId, maxRuntimeTimer);

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
    //
    // El prompt incluye el bloque exit-schema cuando verificationMode
    // lo requiere (modeNeedsExitSchema). El runner es agnóstico —
    // solo recibe el prompt final.
    const resolvedInput: SpawnInput = {
      ...input,
      model: requestedModel,
      prompt: promptWithExit,
    };
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
   * Devuelve el ringbuffer del agente, opcionalmente filtrado/paginado:
   *   - `since`: solo entries con `ts > since` (paginación incremental).
   *   - `kindsFilter`: solo entries cuyo `kind` esté en la lista.
   *   - `tailLines`: solo los últimos N entries POST-filtros.
   *
   * El orden de aplicación importa: kindsFilter → since → tail. Un caller
   * que pasa `kindsFilter=['text'] tailLines=50` recibe los últimos 50
   * `text` (no los últimos 50 entries de los cuales algunos son `text`).
   *
   * El consumidor del MCP `get_agent_log` lo usa para devolver batches
   * al chat externo sin mandar el ringbuffer entero cada vez (un agente
   * verboso genera 153-462 KB de log; con filtros baja a ~10 KB).
   *
   * Devuelve `null` si el agentId no existe.
   */
  getAgentLog(
    agentId: string,
    opts?: {
      since?: number;
      kindsFilter?: LogEntry['kind'][];
      tailLines?: number;
    },
  ): { entries: LogEntry[] } | null {
    const stored = this.agents.get(agentId);
    if (!stored) return null;
    let entries: LogEntry[] = stored.log;
    if (opts?.kindsFilter && opts.kindsFilter.length > 0) {
      const allowed = new Set(opts.kindsFilter);
      entries = entries.filter((e) => allowed.has(e.kind));
    }
    if (typeof opts?.since === 'number' && Number.isFinite(opts.since)) {
      entries = entries.filter((e) => e.ts > opts.since!);
    }
    if (typeof opts?.tailLines === 'number' && opts.tailLines > 0) {
      entries = entries.slice(-opts.tailLines);
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
    const off = this.runningCountListeners.add(cb);
    // Emitimos el count actual al suscribirse para que el StatusBar
    // se pinte coherente sin esperar al primer cambio.
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
    return this.completionListeners.add(cb);
  }

  private notifyCompletion(event: AgentCompletionEvent): void {
    this.completionListeners.emit(event);
  }

  // ====================================================================
  // === wait_for_agents ================================================
  // ====================================================================

  /**
   * Long-poll bloqueante: espera a que todos los `agentIds` lleguen a
   * estado terminal (done/failed/cancelled) o a que venza `timeoutMs`.
   * Devuelve un wire combinado: `results` para los terminados +
   * `pending` para los que siguen running con su `last_message_partial`
   * y flag `suspected_stuck` si llevan demasiado sin emitir eventos.
   *
   * Diseño event-driven (no polling): se suscribe a `onAgentCompleted`
   * filtrando por los `agentIds` del request. Cuando todos terminaron,
   * resuelve inmediato. Si vence el timer, resuelve con `timed_out=true`.
   * Garantía: el listener se des-registra siempre (resolve y timeout
   * path).
   *
   * Idempotency: si llega una segunda call con el mismo set de agent_ids
   * dentro del TTL del waiter (30 min), se suscribe a la MISMA Promise
   * (fan-in) en lugar de crear un waiter nuevo. Permite recuperar la
   * espera después de un transport drop mid-call sin reiniciar el
   * long-poll. Los params (`timeoutMs`, `stuckThresholdMs`) del segundo
   * call se ignoran — el waiter compartido usa los del PRIMER call.
   *
   * El patrón retry del chat: cuando recibe `timed_out: true`, re-llama
   * con los `pending` agent_ids. La description del tool MCP explicita
   * este contrato.
   *
   * AgentIds que no existen en el registry → result con
   * `reason: 'not_found'` (no error operacional; estado válido).
   */
  // Devuelve Promise directo (no async) para preservar la identidad de
  // referencia del waiter cacheado: con `async` el motor envolvería el
  // return en una Promise nueva, rompiendo el fan-in (cada caller
  // recibiría una Promise distinta aunque internamente compartieran
  // resolución). El test explícito `p1 === p2` lo cubre.
  waitForAgents(opts: {
    agentIds: string[];
    timeoutMs: number;
    stuckThresholdMs: number;
  }): Promise<WaitForAgentsResult> {
    const { agentIds, timeoutMs, stuckThresholdMs } = opts;
    const key = waiterKey(agentIds);
    const now = Date.now();

    // === Fan-in: cache hit dentro del TTL ===
    const existing = this.waiterCache.get(key);
    if (existing && now - existing.createdAt < WAITER_TTL_MS) {
      this.channel.appendLine(
        `[${ts()}] [bridge] wait_for_agents fan-in key=${key.slice(0, 16)} (idempotency hit; reusing waiter)`,
      );
      return existing.promise;
    }
    if (existing) {
      // Entry expirado por TTL — sanea antes de continuar.
      this.waiterCache.delete(key);
    }

    // Pre-compute pending set para que runWait pueda decidir si arrancar
    // listener o saltar al critic spawn directo. Mantenemos `'needs_review'`
    // entre los terminales (es un done promovido — no implica que vayamos
    // a re-esperar). Igual decisión para 'failed' y 'cancelled'. La SSoT
    // de qué cuenta como terminal vive en `isTerminalStatus`.
    const pendingSet = new Set<string>();
    for (const id of agentIds) {
      const stored = this.agents.get(id);
      if (!stored) continue;
      if (!isTerminalStatus(stored.snapshot.status)) pendingSet.add(id);
    }

    // === Long-poll con caching (unificado) ===
    // Eliminamos el cheap path inline porque runWait ahora cubre tanto
    // pendingSet vacío (skipea el listener+timer) como el flow del critic
    // post-fan-in. Mantener una sola ruta simplifica reasoning + caching.
    const promise = this.runWait(agentIds, timeoutMs, stuckThresholdMs, pendingSet);

    // LRU eviction FIFO al pasar el cap: descarta el entry más viejo del
    // Map (orden de inserción). Defensivo contra sesiones patológicas;
    // en uso normal el cache nunca supera 1-2 entries.
    //
    // Crítico: limpiar `waiterDegradedState[oldestKey]` también. El waiter
    // evictado puede seguir vivo (otros callers aún lo `await`an), y su
    // `.finally` correrá eventualmente — sin esta limpieza, ese .finally
    // borraría/clearTimeoutearía las entries del waiter NUEVO re-cacheado
    // bajo la misma key, rompiendo el bookkeeping. El `clearTimeout` del
    // viejo se hace acá para que no dispare el degraded del evictado.
    if (this.waiterCache.size >= WAITER_CACHE_MAX) {
      const oldestKey = this.waiterCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.waiterCache.delete(oldestKey);
        const oldTimer = this.waiterDegradedState.get(oldestKey);
        if (oldTimer) clearTimeout(oldTimer);
        if (this.waiterDegradedState.delete(oldestKey)) {
          this.updateTransportState();
        }
      }
    }

    const waiter: SharedWaiter = { promise, createdAt: now };
    this.waiterCache.set(key, waiter);

    // Timer del transport degraded: si el waiter sigue activo en T+60s,
    // el value de la map pasa de Timeout → null (post-threshold) y se
    // dispara la transición del state global. Cleanup al resolver borra
    // la entry, vuelva a healthy si era el último degraded vivo.
    const degradedTimer = setTimeout(() => {
      this.waiterDegradedState.set(key, null);
      this.updateTransportState();
    }, TRANSPORT_DEGRADED_THRESHOLD_MS);
    degradedTimer.unref?.();
    this.waiterDegradedState.set(key, degradedTimer);

    // Cleanup al resolver. Guard de identidad: solo limpiamos las
    // estructuras si la entry en cache todavía es ESTE waiter. Si fue
    // evictado por LRU y otro waiter ocupó la misma key, su cleanup ya
    // ocurrió al evictarlo (ver bloque LRU arriba) — re-borrar acá pisaría
    // las estructuras del waiter sucesor.
    promise.finally(() => {
      if (this.waiterCache.get(key) !== waiter) return;
      this.waiterCache.delete(key);
      const tracked = this.waiterDegradedState.get(key);
      if (tracked) clearTimeout(tracked);
      if (this.waiterDegradedState.delete(key)) {
        this.updateTransportState();
      }
    });

    return promise;
  }

  /**
   * Computa el transportState nuevo (`degraded` si hay 1+ waiters cuyo
   * timer ya disparó — value === null en la map, `healthy` si no) y
   * emite el evento al webview SI cambió. Es no-op cuando el estado se
   * mantiene — la UI solo escucha transiciones.
   */
  private updateTransportState(): void {
    let degradedCount = 0;
    for (const timer of this.waiterDegradedState.values()) {
      if (timer === null) degradedCount++;
    }
    const next: TransportState = degradedCount > 0 ? 'degraded' : 'healthy';
    if (next === this.transportState) return;
    this.transportState = next;
    this.channel.appendLine(
      `[${ts()}] [bridge] transport_state_changed → ${next} (degradedCount=${degradedCount})`,
    );
    this.post({ type: 'transport_state_changed', state: next });
  }

  /** Estado actual del transport (heurístico). Útil para tests + attach. */
  getTransportState(): TransportState {
    return this.transportState;
  }

  /**
   * Ejecuta el long-poll event-driven + post-procesa con D + A según
   * el `verificationMode` de cada agente terminal. Helper extraído de
   * `waitForAgents` para que el flujo de cache quede separado del
   * orquestamiento de verification.
   *
   * Steps:
   *   1. Wait-for-terminal: si `pendingSet.size === 0` (cheap path),
   *      skipea listener + timer. Else suscribe a onAgentCompleted +
   *      arma timeout.
   *   2. Eager D-parse: para cada agente terminal con modeNeedsExitSchema,
   *      parsea el exit del lastAssistantMessage. Auto-promoción a
   *      'needs_review' si decisions/uncertainties no vacíos. Idempotente
   *      por `stored.exitReport` ya seteado.
   *   3. Critic spawn (solo si !timedOut): para agentes con modeNeedsCritic
   *      y sin critic previo, spawn N critics Haiku paralelos con diff.
   *      Cada finding promueve a 'needs_review'.
   *   4. Build wire result con el bloque verification.
   *
   * Cuando `timedOut`, saltamos critics (los agentes pueden seguir
   * corriendo — el wire-out reporta `pending`). El próximo wait
   * post-terminal ejecutará la verification.
   */
  private async runWait(
    agentIds: string[],
    timeoutMs: number,
    stuckThresholdMs: number,
    pendingSet: Set<string>,
  ): Promise<WaitForAgentsResult> {
    // === Step 1: Wait-for-terminal ===
    const timedOut =
      pendingSet.size === 0
        ? false
        : await this.waitForAllTerminal(pendingSet, timeoutMs);

    // === Step 2: Eager D-parse para cada agente terminal ===
    for (const id of agentIds) {
      const stored = this.agents.get(id);
      if (!stored) continue;
      this.parseExitForStored(stored);
    }

    // === Step 3: Critic spawn (solo si no timed out) ===
    if (!timedOut) {
      await this.runCriticsForBatch(agentIds);
    }

    // === Step 4: Marcar verificationReviewed en cada agente terminal ===
    // Una vez que D + A corrieron, los agentes con verificationMode lockeado
    // pasan a `reviewed=true`. La UI usa este flag para renderear el badge
    // verde (OK) u naranja (FLAGGED, derivable de verificationPromoted).
    // No corremos si timedOut: aún hay agentes en flight y no queremos
    // marcar reviewed a algo que aún no terminó.
    if (!timedOut) {
      for (const id of agentIds) {
        const stored = this.agents.get(id);
        if (!stored) continue;
        const mode = stored.verificationMode;
        if (!mode || mode === 'none') continue;
        if (stored.snapshot.verificationReviewed) continue;
        stored.snapshot.verificationReviewed = true;
        this.post({
          type: 'agent_status_changed',
          agentId: id,
          status: stored.snapshot.status,
          metadata: { verificationReviewed: true },
        });
      }
      this.schedulePersist();
    }

    // === Step 5: Build wire-out result ===
    return this.buildWaitResult(agentIds, stuckThresholdMs, timedOut);
  }

  /**
   * Long-poll primitivo: bloquea hasta que todos los `pendingSet`
   * terminen o venza el timer. No-op si pendingSet ya está vacío
   * (el caller skipea cuando puede).
   *
   * Devuelve `true` si timed-out (algunos siguen pending), `false`
   * si todos llegaron a terminal antes del timer.
   */
  private waitForAllTerminal(
    pendingSet: Set<string>,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const off = this.onAgentCompleted((event) => {
        if (pendingSet.delete(event.agentId) && pendingSet.size === 0) {
          off();
          clearTimeout(timer);
          resolve(false);
        }
      });
      const timer = setTimeout(() => {
        off();
        resolve(true);
      }, timeoutMs);
    });
  }

  /**
   * Parsea el exit estructurado del agente (Mecanismo D). Solo corre
   * si:
   *   - El modo de verificación del agente lo requiere
   *     (modeNeedsExitSchema).
   *   - No se parseó antes (idempotente: stored.exitReport y
   *     stored.exitParseReason actúan como guard).
   *
   * Aplica auto-promoción a 'needs_review' cuando el reporte trae
   * decisions/uncertainties no vacíos, y muta `stored.snapshot.status`
   * + emite agent_status_changed para que la UI refleje el cambio.
   */
  private parseExitForStored(stored: StoredAgent): void {
    const mode = stored.verificationMode ?? 'none';
    if (!modeNeedsExitSchema(mode)) return;
    // Idempotencia: si ya parseamos antes (ok o fail), no repetimos.
    if (stored.exitReport || stored.exitParseReason) return;

    const parsed = parseExitSchema(stored.lastAssistantMessage);
    if (!parsed.ok) {
      stored.exitParseReason = parsed.reason;
      this.channel.appendLine(
        `[${ts()}] [verification] {"event":"parse","agentId":"${stored.snapshot.id}","ok":false,"reason":"${parsed.reason}"}`,
      );
      // Persistimos la razón del parse fail: sin esto, una reload
      // pierde el state ("se intentó parsear y falló") y se re-parsea
      // el mismo lastAssistantMessage en la próxima invocación de
      // wait_for_agents, repitiendo trabajo inútil. La mayoría de las
      // demás mutaciones del stored ya scheduleean persist; alinear.
      this.schedulePersist();
      return;
    }
    stored.exitReport = parsed.parsed;
    this.schedulePersist();
    this.channel.appendLine(
      `[${ts()}] [verification] {"event":"parse","agentId":"${stored.snapshot.id}","ok":true,"decisions":${parsed.parsed.decisions_made_without_consultation.length},"uncertainties":${parsed.parsed.uncertainties.length}}`,
    );

    // Auto-promoción D: si el agente declaró decisions/uncertainties,
    // promovemos a 'needs_review'. Si ya está promovido (e.g. por critic
    // de una pasada previa), respetamos el state actual.
    const hasDecisions = parsed.parsed.decisions_made_without_consultation.length > 0;
    const hasUncertainties = parsed.parsed.uncertainties.length > 0;
    if (
      (hasDecisions || hasUncertainties) &&
      stored.snapshot.status !== 'needs_review'
    ) {
      stored.autoPromoteReason = hasDecisions ? 'decisions' : 'uncertainties';
      this.promoteToNeedsReview(stored, stored.autoPromoteReason);
    }
  }

  /**
   * Spawnea critics Haiku en paralelo para cada agente terminal del
   * batch que requiere critic (modeNeedsCritic) y aún no fue revisado
   * (stored.criticFindings === undefined). Asigna findings y aplica
   * promoción si algún flag fue encontrado.
   *
   * Idempotente: una segunda llamada con los mismos ids no re-spawna
   * critics ya corridos (el guard `criticFindings === undefined` lo
   * filtra). Permite fan-in vía idempotency cache sin doble cobro.
   */
  private async runCriticsForBatch(agentIds: string[]): Promise<void> {
    const candidates: Array<{ stored: StoredAgent; id: string }> = [];
    for (const id of agentIds) {
      const stored = this.agents.get(id);
      if (!stored) continue;
      const mode = stored.verificationMode ?? 'none';
      if (!modeNeedsCritic(mode)) continue;
      if (stored.criticFindings !== undefined) continue;
      candidates.push({ stored, id });
    }
    if (candidates.length === 0) return;

    this.channel.appendLine(
      `[${ts()}] [verification] {"event":"critic_spawn","count":${candidates.length}}`,
    );

    // Spawn paralelo con Promise.all. Cada critic captura su propio
    // diff + prompt + ejecuta runner.startAgent(Haiku) con timeout.
    await Promise.all(
      candidates.map(({ stored }) => this.runSingleCritic(stored)),
    );
  }

  /**
   * Critic Haiku para UN agente. Captura el diff, arma el prompt, ejecuta
   * el runner con allow-list Read/Bash/Grep/Glob, parsea el output JSON,
   * guarda findings + costo en stored, promueve a 'needs_review' si flags.
   *
   * No tira: cualquier error del runner queda como flag artificial
   * `{severity:'low', summary:'critic_runner_error'}` en stored.criticFindings.
   */
  private async runSingleCritic(stored: StoredAgent): Promise<void> {
    const start = Date.now();
    // captureCriticDiff es async (execFile promisified) para que las N
    // llamadas paralelas en runCriticsForBatch (via Promise.all) NO se
    // serialicen por block del event loop. Con execFileSync, N=5 critics
    // con diffs grandes serializaban 1-4s antes de que cualquier Haiku
    // call arrancara; con execFile cada fork de git corre concurrente.
    const { diff, truncated } = await captureCriticDiff(stored.cwd, stored.headBefore);

    const prompt = buildCriticPrompt({
      agentName: stored.snapshot.name,
      agentSubtitle: stored.snapshot.subtitle,
      exitReport: stored.exitReport,
      diff,
      diffTruncated: truncated,
    });

    // Timeout: AbortController disparado por setTimeout. El runner
    // honra el abort en su loop interno.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CRITIC_TIMEOUT_MS);

    let criticOutputText: string | null = null;
    let criticCostUsd = 0;
    try {
      const result = await this.runner.startAgent({
        prompt,
        cwd: stored.cwd,
        model: 'haiku',
        tools: CRITIC_TOOL_ALLOWLIST,
        abortSignal: abort.signal,
        // Critic events NO van al log streaming del agente original;
        // si quisiéramos visibilidad, se podrían guardar en un campo
        // aparte. Por ahora descartamos (el critic es opaco para la UI).
        onEvent: () => {},
      });
      criticOutputText = result.finalResponse;
      criticCostUsd = result.costUsd;
    } catch (err) {
      this.channel.appendLine(
        `[${ts()}] [verification] {"event":"critic_error","agentId":"${stored.snapshot.id}","error":"${err instanceof Error ? err.message : String(err)}"}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - start;
    stored.criticDurationMs = durationMs;
    stored.criticCostUsd = criticCostUsd;

    // Orden defensivo: si hay output válido, usalo aunque el abort haya
    // disparado (race rara — el critic completó justo antes del timeout;
    // discardear ese resultado sería falso positivo critic_timeout).
    // Solo si no hay output: aborted → timeout; else → runner_error.
    let findings: RuntimeCriticFinding[];
    if (criticOutputText !== null) {
      findings = parseCriticOutput(criticOutputText).flags;
    } else if (abort.signal.aborted) {
      findings = [{ severity: 'low', summary: 'critic_timeout' }];
    } else {
      findings = [{ severity: 'low', summary: 'critic_runner_error' }];
    }
    stored.criticFindings = findings;

    this.channel.appendLine(
      `[${ts()}] [verification] {"event":"critic_done","agentId":"${stored.snapshot.id}","flagsCount":${findings.length},"costUsd":${criticCostUsd},"durationMs":${durationMs}}`,
    );

    // Promoción por critic: solo cuando hay 1+ flag de severidad
    // 'high' o 'med'. Las severidades 'low' NO promueven porque
    // las usamos para flags sintéticos del propio parser/runner del
    // critic (`critic_timeout`, `critic_no_output`, `critic_invalid_json`,
    // `critic_schema_violation`, `critic_runner_error`) que indican
    // "el critic no pudo verificar bien", NO "el agente hizo algo mal".
    // Esos flags quedan visibles en `critic_findings` del wire-out
    // para que el operador los vea, pero no disparan needs_review.
    //
    // Si en el futuro un real finding de Haiku usa 'low' por estilo,
    // se introduce un campo `kind: 'synthetic' | 'real'` aparte y se
    // promueve por kind=real, no por severity. Por ahora la heurística
    // de severity es suficiente y simple.
    const promotingFindings = findings.filter(
      (f) => f.severity === 'high' || f.severity === 'med',
    );
    if (promotingFindings.length > 0) {
      const existing = stored.autoPromoteReason;
      let nextReason: string;
      if (!existing) {
        nextReason = 'critic_flags';
      } else if (!existing.includes('critic_flags')) {
        nextReason = `${existing}+critic_flags`;
      } else {
        nextReason = existing;
      }
      stored.autoPromoteReason = nextReason;
      this.promoteToNeedsReview(stored, nextReason);
    }
  }

  /**
   * Promueve el snapshot.status a `'needs_review'` y emite el evento
   * de cambio al webview. Idempotente: si ya está promovido, no-op
   * (excepto persist).
   */
  private promoteToNeedsReview(stored: StoredAgent, reason: string): void {
    if (stored.snapshot.status === 'needs_review') {
      // Idempotente para status, pero el flag UI puede no haberse
      // seteado todavía en caso de second-call (critic promueve sobre
      // un D ya promovido). Aseguramos invariante: si está promoted en
      // status, también lo está como flag.
      if (!stored.snapshot.verificationPromoted) {
        stored.snapshot.verificationPromoted = true;
      }
      return;
    }
    stored.snapshot.status = 'needs_review';
    stored.snapshot.verificationPromoted = true;
    this.channel.appendLine(
      `[${ts()}] [verification] {"event":"promote","agentId":"${stored.snapshot.id}","reason":"${reason}"}`,
    );
    this.post({
      type: 'agent_status_changed',
      agentId: stored.snapshot.id,
      status: 'needs_review',
      metadata: { status: 'needs_review', verificationPromoted: true },
    });
    this.schedulePersist();
  }

  /**
   * Construye el `WaitForAgentsResult` final a partir del snapshot
   * del registry. Helper puro: lee el estado actual de cada agente y
   * lo traduce al wire según su `snapshot.status` actual. No mutates.
   */
  private buildWaitResult(
    agentIds: string[],
    stuckThresholdMs: number,
    timedOut: boolean,
  ): WaitForAgentsResult {
    const now = Date.now();
    const results: WaitForAgentsAgentResult[] = [];
    const pending: WaitForAgentsAgentPending[] = [];

    for (const id of agentIds) {
      const stored = this.agents.get(id);
      if (!stored) {
        // Agent_id no existe en el registry — estado válido para el
        // caller (puede haber confundido un id). Wire-out compatible.
        results.push({
          agent_id: id,
          status: 'failed',
          last_message: null,
          duration_ms: 0,
          tokens_used: 0,
          cost_usd: 0,
          reason: 'not_found',
        });
        continue;
      }
      const status = stored.snapshot.status;
      if (isTerminalStatus(status)) {
        const snap = stored.snapshot;
        const verification = this.buildVerificationReport(stored);
        const result: WaitForAgentsAgentResult = {
          agent_id: id,
          status,
          last_message: stored.lastAssistantMessage ?? null,
          duration_ms: snap.durationMs ?? 0,
          tokens_used: snap.tokensUsed ?? 0,
          cost_usd: snap.costUsd ?? 0,
          model: snap.model,
          reason: snap.reason,
        };
        if (verification) {
          result.verification = verification;
        }
        results.push(result);
      } else {
        // 'running' o 'pending' — para el wait, ambos van a pending
        // del wire. El caller no distingue "todavía no arrancó" vs
        // "corriendo": en ambos casos hay que re-pollear.
        const lastActIso = new Date(stored.lastActivityAt).toISOString();
        pending.push({
          agent_id: id,
          status: 'running',
          last_message_partial: stored.lastAssistantMessage ?? null,
          last_activity_at: lastActIso,
          suspected_stuck: now - stored.lastActivityAt > stuckThresholdMs,
        });
      }
    }

    return { results, pending, timed_out: timedOut };
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
    let lastCostUsd = 0;

    try {
      const result = await this.runner.startAgent({
        prompt: input.prompt,
        cwd: input.cwd,
        model: input.model,
        abortSignal: signal,
        onEvent: (event) => {
          // Log al OutputChannel para diagnóstico (igual que MCP/palette ya hacían).
          logAgentEvent(this.channel, event);

          // === Tracking para wait_for_agents ===
          // Cualquier evento marca actividad → resetea el threshold de
          // suspected_stuck. text blocks además acumulan en
          // lastAssistantMessage como progress del agente (lo lee el
          // chat externo via wait_for_agents para mostrar al user qué
          // está diciendo el agente mid-run).
          const tracked = this.agents.get(agentId);
          if (tracked) {
            tracked.lastActivityAt = Date.now();
            if (event.type === 'text' && event.text) {
              tracked.lastAssistantMessage = event.text;
            }
          }

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

          if (event.type === 'usage_turn') {
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
              costUsd: lastCostUsd,
            });
            return;
          }

          if (event.type === 'usage_final') {
            // `usage_final` trae cumulative tokens (todos los turnos)
            // y el `costUsd` definitivo del SDK. Lo que SÍ y NO
            // actualizamos es deliberado:
            //
            //   - `lastTokensUsed`: SÍ actualiza con el cumulative
            //     (input+output a través de todos los turnos). Este es
            //     el costo billable real que la UI RECENT card + toast
            //     muestran al cierre. usage_turn lo ponía con per-turn
            //     delta — quedarse con eso significaría reportar el
            //     último turn en lugar del total acumulado.
            //
            //   - `lastContextTokens` / `lastContextPct`: NO se tocan
            //     en el camino normal. El SDK reporta cache_read
            //     cumulativo en el result (puede superar 200k para
            //     agentes con muchos turnos), y el "context activo"
            //     real es el del último turn. Pisarlos con cumulativos
            //     rompía la barra al cierre (V0_1_0_FIELD_REPORT.md:
            //     contextTokens=10.9M). PERO: para runs error-only o
            //     cached-only que nunca emiten un usage_turn (guard de
            //     `incIn > 0 || incOut > 0` en agent-runner), si
            //     lastContextTokens sigue en 0 al recibir usage_final,
            //     SÍ poblamos con los cumulativos como mejor estimate
            //     posible — preferible a mostrar 0% en un agente que
            //     sí consumió contexto via cache.
            //
            //   - `lastCostUsd`: SÍ con guard >0 (el SDK manda 0
            //     en errors antes de cobrar — guard evita pisar un
            //     cost real con un 0 espurio).
            lastTokensUsed = event.inputTokens + event.outputTokens;
            if (lastContextTokens === 0) {
              lastContextTokens =
                event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens;
              lastContextPct = Math.min(
                100,
                Math.round((lastContextTokens / CONTEXT_WINDOW_TOKENS) * 100),
              );
            }
            if (event.costUsd > 0) {
              lastCostUsd = event.costUsd;
            }
            this.emitStatusChange(agentId, 'running', {
              tokensUsed: lastTokensUsed,
              contextTokens: lastContextTokens,
              contextUsedPct: lastContextPct,
              costUsd: lastCostUsd,
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
        // result.costUsd es la fuente autoritativa (viene del SDK
        // `total_cost_usd`). Usamos el del result si el último usage
        // event no llegó con costo no-cero (puede pasar si el agente
        // termina antes de emitir el result final del turn).
        stored.snapshot.costUsd = result.costUsd || lastCostUsd;
        // Si el cap defensivo ya seteó reason='max_runtime_exceeded'
        // antes del cancel, NO pisamos con el finalResponse del runner
        // (que en cancel queda como "User cancelled").
        if (
          stored.snapshot.reason !== 'max_runtime_exceeded' &&
          wireStatus !== 'done' &&
          result.finalResponse
        ) {
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
      // Cleanup del cap defensivo: cuando el agente termina natural
      // (sin que el timer dispare), cancelamos el setTimeout para no
      // ejecutar un cancel inútil después.
      const tmr = this.maxRuntimeTimers.get(agentId);
      if (tmr) {
        clearTimeout(tmr);
        this.maxRuntimeTimers.delete(agentId);
      }
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
      // — eso sí mantiene info válida. `isTerminalStatus` cubre
      // done/failed/cancelled/needs_review como SSoT — sin esto, un
      // status nuevo agregado a AgentStatus quedaba fuera del check
      // y permitía sobrescritura silenciosa.
      if (!isTerminalStatus(stored.snapshot.status)) {
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

    // Defensive: limpiar timers del cap maxAgentRuntimeSec. En el
    // happy path el `finally` del run() los limpia uno por uno cuando
    // resuelven los runs activos arriba. Esta limpieza extra cubre el
    // caso patológico donde algún timer quedó colgado (run() lanzó
    // fuera del try/finally, etc.) — sin esto, el callback puede
    // dispararse después del dispose y appendLine sobre un channel
    // posiblemente disposed.
    for (const t of this.maxRuntimeTimers.values()) {
      clearTimeout(t);
    }
    this.maxRuntimeTimers.clear();

    // Mismo patrón defensivo para los timers del transport-degraded
    // heurístico: si dispose corre mientras un waiter está vivo, el
    // timer se dispararía después del shutdown contra estructuras ya
    // limpias. Los valores `null` (timer ya disparado) no requieren
    // clearTimeout.
    for (const timer of this.waiterDegradedState.values()) {
      if (timer) clearTimeout(timer);
    }
    this.waiterDegradedState.clear();

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

  /**
   * Arma el bloque wire `VerificationReport` para un agente. Solo retorna
   * algo si el modo del agente NO es 'none'; sin eso, el wire-out de
   * agentes pre-0.2.0 (que no llevan verificationMode) y agentes con
   * mode='none' queda sin ese campo opcional — backwards-compat.
   *
   * Los sub-campos son condicionales:
   *   - exit_report y exit_parse_reason: solo cuando modeNeedsExitSchema.
   *   - critic_findings / cost / duration: solo cuando modeNeedsCritic.
   *   - auto_promoted_reason: cuando el bridge promovió a needs_review.
   */
  private buildVerificationReport(stored: StoredAgent): VerificationReport | null {
    const mode = stored.verificationMode;
    if (!mode || mode === 'none') return null;

    const report: VerificationReport = { mode };
    if (modeNeedsExitSchema(mode)) {
      if (stored.exitReport) {
        // Copia shallow del runtime ExitReport al wire ExitReport.
        // Mismo shape — el tipo wire solo lista los 5 campos
        // canónicos (sin `passthrough` runtime). Filtramos extras.
        const e = stored.exitReport;
        const wireExit: ExitReport = {
          status: e.status,
          files_changed: e.files_changed,
          evidence_run: e.evidence_run,
          decisions_made_without_consultation: e.decisions_made_without_consultation,
          uncertainties: e.uncertainties,
        };
        report.exit_report = wireExit;
      } else if (stored.exitParseReason) {
        report.exit_parse_reason = stored.exitParseReason;
      }
    }
    if (modeNeedsCritic(mode) && stored.criticFindings !== undefined) {
      // Copia shallow de cada finding (mismo shape runtime → wire).
      const wireFindings: CriticFinding[] = stored.criticFindings.map((f) => ({
        file: f.file,
        line: f.line,
        severity: f.severity,
        summary: f.summary,
      }));
      report.critic_findings = wireFindings;
      if (typeof stored.criticCostUsd === 'number') {
        report.critic_cost_usd = stored.criticCostUsd;
      }
      if (typeof stored.criticDurationMs === 'number') {
        report.critic_duration_ms = stored.criticDurationMs;
      }
    }
    if (stored.autoPromoteReason) {
      report.auto_promoted_reason = stored.autoPromoteReason;
    }
    return report;
  }

  private makeAgentId(): string {
    return crypto.randomUUID();
  }

  /**
   * Lee `claudeOrchestrator.verification` con validación defensiva.
   * Cualquier string fuera del enum cae a DEFAULT_VERIFICATION_MODE
   * ('structured'). Lo lee el spawn() para lockear el modo de cada
   * agente al momento de su creación.
   */
  private getVerificationMode(): VerificationMode {
    const cfg = vscode.workspace.getConfiguration('claudeOrchestrator');
    const raw = cfg.get<string>('verification', DEFAULT_VERIFICATION_MODE);
    return (VERIFICATION_MODES as readonly string[]).includes(raw)
      ? (raw as VerificationMode)
      : DEFAULT_VERIFICATION_MODE;
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
    case 'usage_turn':
      return {
        ts: tsMs,
        kind: 'usage',
        tokensUsed: event.inputTokens + event.outputTokens,
      };
    case 'usage_final':
      // El terminal block del run() ya consume usage_final para fijar
      // costUsd + tokensUsed acumulados; no agregamos otro entry al
      // ringbuffer porque ya hay uno por cada `usage_turn` del agente
      // y el LogStream del detail panel se inundaría con un duplicado
      // visualmente idéntico al cierre.
      return null;
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

/**
 * Snapshot del HEAD git en `cwd` para que el critic post-fan-in pueda
 * computar `git diff <headBefore>..HEAD`. Retorna undefined si:
 *   - El cwd no es un repo git.
 *   - Git no está instalado.
 *   - El repo está vacío (sin commits).
 * En esos casos, el critic recibe un diff vacío y normalmente reporta
 * `summary: 'no diff'` con flags vacíos.
 *
 * Exportable y puro (solo lee filesystem) — los tests del bridge lo
 * mockean para verificar el flow sin necesidad de repo git real.
 */
export function readGitHead(cwd: string): string | undefined {
  try {
    const out = childProcess.execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', 'HEAD'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      },
    );
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Captura el diff `<headBefore>` working-tree vs commit desde `cwd`.
 * Truncado a CRITIC_DIFF_MAX_BYTES si supera; el caller flaggea al
 * critic en el prompt (buildCriticPrompt acepta `diffTruncated: boolean`).
 *
 * Retorna `{diff: '', truncated: false}` si:
 *   - headBefore es undefined (cwd no era repo al spawn).
 *   - git diff falla (HEAD no resoluble, repo corrupto).
 *
 * No tira en ninguna rama. **Async** (execFile promisified) para que el
 * Promise.all en runCriticsForBatch realmente paralelice los N forks de
 * git — con execFileSync los forks bloqueaban el event loop y se
 * serializaban a pesar del Promise.all wrapper.
 *
 * Exportable para tests.
 */
export async function captureCriticDiff(
  cwd: string,
  headBefore: string | undefined,
): Promise<{ diff: string; truncated: boolean }> {
  if (!headBefore) {
    return { diff: '', truncated: false };
  }
  let out = '';
  try {
    // `git diff <commit>` compara WORKING TREE vs commit dado. Esto es
    // crítico para el critic: el agente Claude modifica archivos pero
    // NO los commitea, así que HEAD no se mueve entre spawn y close.
    // Si usaramos `git diff <headBefore>..HEAD` (comparación entre dos
    // commits), el diff sería siempre vacío y el critic no vería los
    // cambios reales del agente — silent failure de Mecanismo A.
    //
    // Para incluir también archivos staged que el agente pudo haber
    // `git add`-eado sin commitear, `git diff <commit>` ya incluye
    // staged+working (es el "diff total respecto del commit"). NO
    // incluye archivos NUEVOS sin track — el critic los pierde, pero
    // los archivos nuevos suelen ser cambios menos ambiguos (más
    // obvios al review humano post-fan-in) y el caso típico del Mecanismo
    // A es atrapar flips/refactors silenciosos en archivos existentes.
    out = await execFileAsync(
      'git',
      ['-C', cwd, 'diff', headBefore],
      {
        encoding: 'utf-8',
        // 5s es un buen balance: diffs grandes (10-50 MB) toman 1-2s
        // en discos lentos. Más allá indica un repo patológico.
        timeout: 5000,
        // maxBuffer default es 1 MB. Subimos a 10 MB para no recortar
        // diffs grandes ANTES de nuestro truncate canonical de 500 KB.
        // El truncate canonical se aplica abajo.
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  } catch {
    return { diff: '', truncated: false };
  }
  if (out.length <= CRITIC_DIFF_MAX_BYTES) {
    return { diff: out, truncated: false };
  }
  return { diff: out.slice(0, CRITIC_DIFF_MAX_BYTES), truncated: true };
}
