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

const DEFAULT_PORT = 8080;
const DEFAULT_ROUTE_DOMAIN = "localhost";

interface Service {
  name: string;
  socketPath: string;
  port: number;
  registeredAt: Date;
}

interface DaemonConfig {
  port: number;
  routeDomain: string; // e.g., "localhost"
}

export class LohostDaemon {
  private services = new Map<string, Service>();
  private server: ReturnType<typeof createHttpServer> | null = null;
  private config: DaemonConfig;

  constructor(config: Partial<DaemonConfig> = {}) {
    this.config = {
      port: config.port ?? DEFAULT_PORT,
      routeDomain: config.routeDomain ?? DEFAULT_ROUTE_DOMAIN,
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

    // Debug dashboard at _lohost.localhost
    const hostWithoutPort = (req.headers.host ?? "").split(":")[0];
    if (hostWithoutPort === "_lohost.localhost" || hostWithoutPort === "lohost.localhost") {
      this.serveDashboard(req, res);
      return;
    }

    // Extract subdomain from host
    const subdomain = this.extractSubdomain(req.headers.host);
    if (!subdomain) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(`Bad Request: Host must end with .${this.config.routeDomain}`);
      return;
    }

    // Find matching service using longest-suffix match
    const service = this.findService(subdomain);
    if (!service) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`Not Found: No service matches "${subdomain}"`);
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
      // Reconstruct the HTTP upgrade request with original headers
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
    const url = req.url ?? "";

    if (url === "/_lohost/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        services: this.services.size,
        routeDomain: this.config.routeDomain,
      }));
      return;
    }

    if (url === "/_lohost/services" && req.method === "GET") {
      const services = this.getSortedServices();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(services));
      return;
    }

    if (url === "/_lohost/register" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { name, socketPath, port } = JSON.parse(body);
          if (!name || !socketPath || !port) {
            res.writeHead(400, { "Content-Type": "application/json" });
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
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ url: serviceUrl }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
      return;
    }

    const deregisterMatch = url.match(/^\/_lohost\/register\/(.+)$/);
    if (deregisterMatch && req.method === "DELETE") {
      const name = deregisterMatch[1];
      if (this.services.has(name)) {
        this.services.delete(name);
        console.error(`[lohostd] - ${name}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ removed: name }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
      return;
    }

    if (url === "/_lohost/stop" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ stopping: true }));
      setTimeout(() => process.exit(0), 100);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private serveDashboard(_req: IncomingMessage, res: ServerResponse): void {
    const services = this.getSortedServices();

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>lohost dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; }
    h1 { color: #333; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; }
    a { color: #0066cc; }
    .status { color: #22c55e; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; }
    .group-spacer td { height: 12px; border-bottom: none; }
    .group-header { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; padding-top: 4px; }
  </style>
</head>
<body>
  <h1>lohost dashboard</h1>
  <p><span class="status">●</span> Running on port ${this.config.port} | Route domain: <code>${this.config.routeDomain}</code></p>
  <h2>Registered Services (${services.length})</h2>
  <table>
    <tr><th>Name</th><th>URL</th><th>Socket</th><th>Port</th></tr>
    ${services.map((s, i) => {
      const spacer = s.isFirstInGroup && i > 0
        ? `<tr class="group-spacer"><td colspan="4"></td></tr>`
        : "";
      const groupLabel = s.groupName
        ? `<span class="group-header">${s.groupName}</span><br>`
        : "";
      return `${spacer}
    <tr>
      <td>${groupLabel}<strong>${s.name}</strong></td>
      <td><a href="${s.url}" target="_blank">${s.url}</a></td>
      <td><code>${s.socketPath}</code></td>
      <td>${s.port}</td>
    </tr>`;
    }).join("")}
  </table>
  <p style="margin-top: 30px; color: #666; font-size: 14px;">
    API: <a href="/_lohost/health">/_lohost/health</a> | <a href="/_lohost/services">/_lohost/services</a>
  </p>
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  }

  /**
   * Extract subdomain from Host header.
   * "api.websim.localhost:8080" → "api.websim"
   * "websim.localhost:8080" → "websim"
   */
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

  /**
   * Find the service that matches the subdomain using longest-suffix matching.
   * For "xxx.c.websim", checks: "xxx.c.websim", "c.websim", "websim"
   */
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

  /**
   * Get services sorted by segments, rightmost first, grouped by base name.
   * Services are grouped by their rightmost segment (e.g., "websim", "websim2").
   * Within each group, services are sorted by remaining segments right-to-left.
   * Returns array with spacer markers between groups.
   */
  private getSortedServices(): Array<{
    name: string;
    socketPath: string;
    port: number;
    url: string;
    registeredAt: string;
    isFirstInGroup?: boolean;
    groupName?: string;
  }> {
    const services = Array.from(this.services.values()).map((s) => ({
      name: s.name,
      socketPath: s.socketPath,
      port: s.port,
      url: `http://${s.name}.${this.config.routeDomain}:${this.config.port}`,
      registeredAt: s.registeredAt.toISOString(),
    }));

    // Group by rightmost segment
    const groups = new Map<string, typeof services>();
    for (const service of services) {
      const parts = service.name.split(".");
      const groupName = parts[parts.length - 1];
      if (!groups.has(groupName)) {
        groups.set(groupName, []);
      }
      groups.get(groupName)!.push(service);
    }

    // Sort group names lexicographically
    const sortedGroupNames = Array.from(groups.keys()).sort((a, b) =>
      a.localeCompare(b)
    );

    // Sort services within each group by remaining segments (right-to-left)
    const sortWithinGroup = (a: (typeof services)[0], b: (typeof services)[0]) => {
      const aParts = a.name.split(".").reverse();
      const bParts = b.name.split(".").reverse();
      const maxLen = Math.max(aParts.length, bParts.length);
      for (let i = 0; i < maxLen; i++) {
        const aSegment = aParts[i] ?? "";
        const bSegment = bParts[i] ?? "";
        if (aSegment !== bSegment) {
          return aSegment.localeCompare(bSegment);
        }
      }
      return 0;
    };

    // Build result with group markers
    const result: ReturnType<typeof this.getSortedServices> = [];
    for (const groupName of sortedGroupNames) {
      const groupServices = groups.get(groupName)!;
      groupServices.sort(sortWithinGroup);

      for (let i = 0; i < groupServices.length; i++) {
        result.push({
          ...groupServices[i],
          isFirstInGroup: i === 0,
          groupName: i === 0 ? groupName : undefined,
        });
      }
    }

    return result;
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
      headers: req.headers, // Pass through original headers unchanged
    };

    const proxyReq = httpRequest(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      console.error(`[lohostd] Proxy error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Bad Gateway: Backend unavailable");
      }
    });

    req.pipe(proxyReq);
  }
}
