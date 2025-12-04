/**
 * lohostd - HTTP router daemon
 *
 * Listens on port 8080, routes requests by Host header to UDS sockets.
 * Host headers are passed through unchanged.
 *
 * Routing:
 *   {subdomain}.{name}.localhost:8080 → /tmp/{name}.sock
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
  request as httpRequest,
} from "node:http";
import { createConnection, type Socket } from "node:net";

const VERSION = "0.0.1";
const DEFAULT_PORT = 8080;
const DEFAULT_ROUTE_DOMAIN = "localhost";
const DEFAULT_SOCKET_DIR = "/tmp";

interface Service {
  name: string;
  socketPath: string;
  port: number;
  registeredAt: Date;
}

interface DaemonConfig {
  port: number;
  routeDomain: string;
  socketDir: string;
}

export class LohostDaemon {
  private services = new Map<string, Service>();
  private server: ReturnType<typeof createHttpServer> | null = null;
  private config: DaemonConfig;
  private startedAt: Date = new Date();

  constructor(config: Partial<DaemonConfig> = {}) {
    this.config = {
      port: config.port ?? DEFAULT_PORT,
      routeDomain: config.routeDomain ?? DEFAULT_ROUTE_DOMAIN,
      socketDir: config.socketDir ?? DEFAULT_SOCKET_DIR,
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createHttpServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on("upgrade", (req, socket, head) => {
        this.handleUpgrade(req, socket as Socket, head);
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${this.config.port} is already in use`));
        } else {
          reject(err);
        }
      });

      this.server.listen(this.config.port, () => {
        this.startedAt = new Date();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";

    // API routes
    if (url.startsWith("/_lohost/")) {
      this.handleApi(req, res);
      return;
    }

    // Extract subdomain from host
    const subdomain = this.extractSubdomain(req.headers.host);
    if (!subdomain) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Bad Request",
        message: `Host must end with .${this.config.routeDomain}`,
      }));
      return;
    }

    // Find matching service using longest-suffix match
    const service = this.findService(subdomain);
    if (!service) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Not Found",
        message: `No service matches "${subdomain}"`,
      }));
      return;
    }

    // Forward to backend with original Host header preserved
    this.proxyToSocket(req, res, service.socketPath);
  }

  private handleUpgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer
  ): void {
    const subdomain = this.extractSubdomain(req.headers.host);
    if (!subdomain) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const service = this.findService(subdomain);
    if (!service) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    // Connect to UDS and proxy the upgrade
    const udsSocket = createConnection(service.socketPath);

    udsSocket.on("connect", () => {
      const headers = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value) continue;
        headers.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
      }
      headers.push("", "");

      udsSocket.write(headers.join("\r\n"));
      if (head.length > 0) {
        udsSocket.write(head);
      }

      socket.pipe(udsSocket);
      udsSocket.pipe(socket);
    });

    udsSocket.on("error", () => {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
    });

    socket.on("error", () => {
      udsSocket.destroy();
    });
  }

  private handleApi(req: IncomingMessage, res: ServerResponse): void {
    // CORS headers for local dev tools
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const url = req.url ?? "";
    const headers = { "Content-Type": "application/json", ...corsHeaders };

    // GET /_lohost/health
    if (url === "/_lohost/health" && req.method === "GET") {
      const uptime = Math.floor((Date.now() - this.startedAt.getTime()) / 1000);
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        status: "ok",
        version: VERSION,
        uptime,
        services: this.services.size,
      }));
      return;
    }

    // GET /_lohost/config
    if (url === "/_lohost/config" && req.method === "GET") {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        version: VERSION,
        port: this.config.port,
        routeDomain: this.config.routeDomain,
        socketDir: this.config.socketDir,
      }));
      return;
    }

    // GET /_lohost/services
    if (url === "/_lohost/services" && req.method === "GET") {
      const services = this.getServicesArray();
      res.writeHead(200, headers);
      res.end(JSON.stringify(services));
      return;
    }

    // GET /_lohost/services/:name
    const serviceMatch = url.match(/^\/_lohost\/services\/(.+)$/);
    if (serviceMatch && req.method === "GET") {
      const name = serviceMatch[1];
      const service = this.services.get(name);
      if (service) {
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          name: service.name,
          port: service.port,
          socketPath: service.socketPath,
          url: `http://${service.name}.${this.config.routeDomain}:${this.config.port}`,
          registeredAt: service.registeredAt.toISOString(),
        }));
      } else {
        res.writeHead(404, headers);
        res.end(JSON.stringify({ error: "Service not found", name }));
      }
      return;
    }

    // POST /_lohost/register
    if (url === "/_lohost/register" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { name, socketPath, port } = JSON.parse(body);
          if (!name || !socketPath || !port) {
            res.writeHead(400, headers);
            res.end(JSON.stringify({ error: "name, socketPath, and port required" }));
            return;
          }
          this.services.set(name, {
            name,
            socketPath,
            port,
            registeredAt: new Date(),
          });
          const serviceUrl = `http://${name}.${this.config.routeDomain}:${this.config.port}`;
          console.error(`[lohostd] + ${name} → ${socketPath} (port ${port})`);
          res.writeHead(200, headers);
          res.end(JSON.stringify({ url: serviceUrl }));
        } catch {
          res.writeHead(400, headers);
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
      return;
    }

    // DELETE /_lohost/register/:name
    const deregisterMatch = url.match(/^\/_lohost\/register\/(.+)$/);
    if (deregisterMatch && req.method === "DELETE") {
      const name = deregisterMatch[1];
      if (this.services.has(name)) {
        this.services.delete(name);
        console.error(`[lohostd] - ${name}`);
        res.writeHead(200, headers);
        res.end(JSON.stringify({ removed: name }));
      } else {
        res.writeHead(404, headers);
        res.end(JSON.stringify({ error: "Not found" }));
      }
      return;
    }

    // POST /_lohost/stop
    if (url === "/_lohost/stop" && req.method === "POST") {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ stopping: true }));
      setTimeout(() => process.exit(0), 100);
      return;
    }

    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private extractSubdomain(host: string | undefined): string | null {
    if (!host) return null;

    const hostWithoutPort = host.split(":")[0];
    const suffix = `.${this.config.routeDomain}`;

    if (!hostWithoutPort.endsWith(suffix)) {
      return null;
    }

    const subdomain = hostWithoutPort.slice(0, -suffix.length);
    return subdomain || null;
  }

  private findService(subdomain: string): Service | null {
    const parts = subdomain.split(".");

    for (let i = 0; i < parts.length; i++) {
      const candidate = parts.slice(i).join(".");
      const service = this.services.get(candidate);
      if (service) {
        return service;
      }
    }

    return null;
  }

  private getServicesArray(): Array<{
    name: string;
    port: number;
    socketPath: string;
    url: string;
    registeredAt: string;
  }> {
    return Array.from(this.services.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({
        name: s.name,
        port: s.port,
        socketPath: s.socketPath,
        url: `http://${s.name}.${this.config.routeDomain}:${this.config.port}`,
        registeredAt: s.registeredAt.toISOString(),
      }));
  }

  private proxyToSocket(
    req: IncomingMessage,
    res: ServerResponse,
    socketPath: string
  ): void {
    const options = {
      socketPath,
      path: req.url,
      method: req.method,
      headers: req.headers,
    };

    const proxyReq = httpRequest(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      console.error(`[lohostd] Proxy error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Gateway", message: "Backend unavailable" }));
      }
    });

    req.pipe(proxyReq);
  }
}
