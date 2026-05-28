import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as vscode from 'vscode';
import type { DashboardBridge } from '../dashboard/bridge';
import { ts } from '../runtime/log';
import { OrchestratorMcpServer } from './server';

// Puerto fijo. Decisión consciente:
//   - Hacerlo configurable agrega 1 setting de VS Code que nadie va a usar.
//   - Un user con 2 EDH abiertas a la vez no es el caso típico; si pasa,
//     la segunda EDH detecta EADDRINUSE y skipea solo el MCP server
//     (testAgent/cancel siguen disponibles vía paleta).
//   - El número (39127) es arbitrario alto, baja probabilidad de colisión
//     con servicios comunes (ssh 22, http 80, http-alt 8080, etc.).
const MCP_PORT = 39127;
const MCP_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';

const ALLOWED_HOSTS = [
  `${MCP_HOST}:${MCP_PORT}`,
  `localhost:${MCP_PORT}`,
];

export interface OrchestratorHttpServerOptions {
  channel: vscode.OutputChannel;
  bridge: DashboardBridge;
  serverInfo: { name: string; version: string };
  // Token bearer requerido en el header `Authorization` de cada request.
  // Sin él, cualquier proceso local podría invocar el tool y gastar crédito
  // del usuario (bypassPermissions=true expone Bash/Edit a cualquier caller).
  bearerToken: string;
}

/**
 * Wrapper de servidor HTTP local que expone el MCP orquestador en
 * `http://127.0.0.1:39127/mcp`. La construcción de McpServer + transport
 * es responsabilidad del `OrchestratorMcpServer` (uno fresh por request);
 * acá solo manejamos socket, ruteo trivial y ciclo de vida.
 */
export class OrchestratorHttpServer {
  private readonly mcp: OrchestratorMcpServer;
  private readonly channel: vscode.OutputChannel;
  // Buffer pre-codificado para comparar en tiempo constante en cada request.
  // Almacenarlo como Buffer evita re-alocar en el hot path.
  private readonly expectedAuthHeader: Buffer;
  private httpServer: http.Server | null = null;

  constructor(options: OrchestratorHttpServerOptions) {
    this.channel = options.channel;
    this.expectedAuthHeader = Buffer.from(`Bearer ${options.bearerToken}`, 'utf-8');
    this.mcp = new OrchestratorMcpServer({
      channel: options.channel,
      bridge: options.bridge,
      serverInfo: options.serverInfo,
      allowedHosts: ALLOWED_HOSTS,
    });
  }

  async start(): Promise<void> {
    const stamp = ts();

    // node:http nativo en vez de Express. El SDK trae Express como dep
    // transitiva, pero el transport del SDK acepta `IncomingMessage` directo
    // y el path único /mcp no justifica un router.
    this.httpServer = http.createServer((req, res) => this.handleRequest(req, res));

    // === Bind con manejo de EADDRINUSE ===
    // Si el puerto está ocupado (segunda EDH, otro proceso) loggeamos y
    // resolvemos sin levantar el server. La extensión sigue funcional para
    // los comandos del palette; solo el MCP queda offline.
    await new Promise<void>((resolve, reject) => {
      const onListenError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this.channel.appendLine(
            `[${ts()}] [mcp] !!! port ${MCP_PORT} in use; skipping MCP server (other EDH or service holding it).`,
          );
          this.httpServer = null;
          resolve();
        } else {
          reject(err);
        }
      };
      this.httpServer!.once('error', onListenError);
      this.httpServer!.listen(MCP_PORT, MCP_HOST, () => {
        this.httpServer!.removeListener('error', onListenError);
        this.channel.appendLine(
          `[${stamp}] [mcp] server listening on http://${MCP_HOST}:${MCP_PORT}${MCP_PATH}`,
        );
        resolve();
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.httpServer) {
      // Forzamos el cierre de conexiones activas (Node 18.2+) ANTES de
      // esperar a `close()`. Sin esto, una request en curso (ej. un agente
      // todavía ejecutándose) cuelga la desactivación de la extensión hasta
      // que termine. El `req.on('close')` del handler del tool ya cablea
      // el abort del agente cuando el socket muere, así que cerrar acá
      // propaga la cancelación río abajo.
      this.httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
    await this.mcp.dispose();
    this.channel.appendLine(`[${ts()}] [mcp] server stopped`);
  }

  /**
   * Handler de cada request HTTP. Extraído del createServer callback para
   * poder testearlo directo sin levantar un server (ESM impide spyOn de
   * `http.createServer`). Aplica filtrado de path → auth bearer → hooks
   * de keep-alive → delega al MCP.
   *
   * Visibilidad `public` para tests; ningún caller externo lo usa fuera
   * del propio createServer interno.
   */
  public handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Filtramos paths fuera de /mcp antes de meter al wrapper MCP: el SDK
    // tiene su propia respuesta para rutas inválidas pero loguearíamos
    // como "transport error" cualquier request errante, contaminando el
    // OutputChannel con ruido (ej. el probe del browser a /favicon.ico).
    if (!req.url || !req.url.startsWith(MCP_PATH)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    // Auth bearer ANTES de delegar al MCP. Hacemos la comparación en
    // tiempo constante con `timingSafeEqual` para no filtrar el prefijo
    // correcto vía side-channel; en localhost el ataque es marginal pero
    // el costo es ínfimo y mantiene la práctica higiénica.
    if (!this.authorize(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // === Transport resilience ===
    // El `wait_for_agents` puede tener un long-poll de hasta 1200s. El
    // field report v0.1.0 documentó drops mid-call < 60s — el síntoma
    // típico de un socket cerrado por TCP idle timeout o middleware
    // intermedio. Sin estos hooks Node tira el socket por defecto a los
    // 2 min de inactividad y el cliente recibe "transport dropped":
    //
    //   - `Connection: keep-alive` + Keep-Alive timeout amplio: deja
    //     claro que el server tolera conexiones largas (algunos
    //     proxies usan estos headers para decidir si mantener el
    //     socket abierto).
    //   - `socket.setKeepAlive(true, 15s)`: dispara TCP keep-alive
    //     probes cada 15s para que el kernel mantenga vivo el socket
    //     aún con tráfico cero. Esto evita el drop silencioso en
    //     middleware con idle-disconnect.
    //   - `socket.setTimeout(0)`: desactiva el idle timeout de Node
    //     (default 0 ya, pero explícito para no depender de futuros
    //     cambios del Node default).
    //
    // Si el drop persiste pese a estos hooks, la idempotency del
    // bridge (waiterCache) recoge el waiter al re-call del modelo —
    // ese es el safety net real.
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=1200, max=1000');
    // Optional chain: si el cliente abortó el TCP antes de llegar acá,
    // `req.socket` puede estar destroyed o null en algunos paths de Node.
    // Sin el guard, setKeepAlive lanza TypeError sync que escapa del
    // .catch del handler async — uncaught exception en el http server.
    req.socket?.setKeepAlive(true, 15_000);
    req.socket?.setTimeout(0);

    this.mcp.handleHttpRequest(req, res).catch((err) => {
      // Si handleHttpRequest tira, el cliente nunca recibe respuesta y se
      // queda colgado. Cerramos defensivamente con 500. El error va al
      // OutputChannel para diagnóstico.
      this.channel.appendLine(
        `[${ts()}] [mcp] !!! unhandled http error: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_server_error' }));
      } else {
        res.end();
      }
    });
  }

  // Valida el header `Authorization: Bearer <token>` en tiempo constante.
  // Devuelve false si el header falta, está mal formado, o no coincide.
  private authorize(req: http.IncomingMessage): boolean {
    const header = req.headers['authorization'];
    if (typeof header !== 'string') {
      return false;
    }
    const received = Buffer.from(header, 'utf-8');
    if (received.length !== this.expectedAuthHeader.length) {
      return false;
    }
    return crypto.timingSafeEqual(received, this.expectedAuthHeader);
  }
}
