/**
 * lohost client - UDS proxy + daemon interaction
 *
 * Creates a UDS socket, registers with lohostd, proxies to TCP.
 */

import {
  createServer,
  createConnection,
  type Socket,
  type Server,
} from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { unlinkSync } from "node:fs";
import { request } from "node:http";

const DEFAULT_DAEMON_PORT = 8080;
const DEFAULT_SOCKET_DIR = "/tmp";

interface ClientOptions {
  name: string;
  socketDir?: string;
  daemonPort?: number;
}

export class LohostClient {
  private name: string;
  private socketDir: string;
  private socketPath: string;
  private daemonPort: number;
  private daemonUrl: string;
  private proxy: Server | null = null;
  private child: ChildProcess | null = null;
  private connections = new Set<Socket>();
  private tcpPort: number = 0;

  constructor(options: ClientOptions) {
    this.name = options.name;
    this.socketDir = options.socketDir ?? DEFAULT_SOCKET_DIR;
    this.socketPath = `${this.socketDir}/${this.name}.sock`;
    this.daemonPort = options.daemonPort ?? DEFAULT_DAEMON_PORT;
    this.daemonUrl = `http://localhost:${this.daemonPort}`;
  }

  async run(command: string, args: string[]): Promise<number> {
    // 1. Find free port
    this.tcpPort = await this.findFreePort();

    // 2. Clean up stale socket
    this.cleanupSocket();

    // 3. Create UDS proxy
    await this.startProxy();

    // 4. Ensure daemon is running
    await this.ensureDaemon();

    // 5. Register with daemon
    await this.register();

    // 6. Spawn child
    return this.spawnChild(command, args);
  }

  private async findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (addr && typeof addr === "object") {
          const port = addr.port;
          srv.close(() => resolve(port));
        } else {
          srv.close(() => reject(new Error("Failed to get port")));
        }
      });
    });
  }

  private cleanupSocket(): void {
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Ignore - socket may not exist
    }
  }

  private async startProxy(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proxy = createServer((udsConn) => {
        this.connections.add(udsConn);

        const tcpConn = createConnection({
          port: this.tcpPort,
          host: "localhost", // Use localhost to support both IPv4 and IPv6
        });
        this.connections.add(tcpConn);

        udsConn.pipe(tcpConn);
        tcpConn.pipe(udsConn);

        const cleanup = () => {
          this.connections.delete(udsConn);
          this.connections.delete(tcpConn);
          udsConn.destroy();
          tcpConn.destroy();
        };

        udsConn.on("error", cleanup);
        udsConn.on("close", cleanup);
        tcpConn.on("error", cleanup);
        tcpConn.on("close", cleanup);
      });

      this.proxy.on("error", reject);
      this.proxy.listen(this.socketPath, () => {
        console.error(`lohost: ${this.socketPath} → 127.0.0.1:${this.tcpPort}`);
        resolve();
      });
    });
  }

  private async ensureDaemon(): Promise<void> {
    // Fast path: already running
    if (await this.checkDaemonHealth()) {
      return;
    }

    // Spawn daemon (detached, fire-and-forget)
    this.spawnDaemon();

    // Wait for it to be ready
    for (let i = 0; i < 30; i++) {
      await this.sleep(100);
      if (await this.checkDaemonHealth()) {
        return;
      }
    }

    throw new Error(`lohostd failed to start on port ${this.daemonPort}`);
  }

  private async checkDaemonHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = request(
        `${this.daemonUrl}/_lohost/health`,
        { timeout: 500 },
        (res) => {
          resolve(res.statusCode === 200);
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  private spawnDaemon(): void {
    const child = spawn(process.execPath, [process.argv[1], "daemon"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, LOHOST_PORT: String(this.daemonPort) },
    });
    child.unref();
  }

  private async register(): Promise<void> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        name: this.name,
        socketPath: this.socketPath,
        port: this.tcpPort,
      });

      const req = request(
        `${this.daemonUrl}/_lohost/register`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            if (res.statusCode === 200) {
              try {
                const result = JSON.parse(body);
                console.error(`lohost: ${result.url}`);
                resolve();
              } catch {
                resolve();
              }
            } else {
              reject(new Error(`Registration failed: ${body}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  private async deregister(): Promise<void> {
    return new Promise((resolve) => {
      const req = request(
        `${this.daemonUrl}/_lohost/register/${this.name}`,
        { method: "DELETE" },
        () => resolve()
      );
      req.on("error", () => resolve()); // Ignore errors on cleanup
      req.end();
    });
  }

  private spawnChild(command: string, args: string[]): Promise<number> {
    return new Promise((resolve) => {
      this.child = spawn(command, args, {
        env: { ...process.env, PORT: String(this.tcpPort) },
        stdio: "inherit",
      });

      const shutdown = (signal: NodeJS.Signals) => {
        this.child?.kill(signal);
      };

      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));

      this.child.on("exit", async (code, signal) => {
        // Deregister from daemon
        await this.deregister();

        // Close all connections
        for (const conn of this.connections) {
          conn.destroy();
        }

        // Close proxy
        this.proxy?.close();

        // Clean up socket
        this.cleanupSocket();

        if (signal) {
          process.kill(process.pid, signal);
        } else {
          resolve(code ?? 0);
        }
      });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// API client for CLI commands
export async function listServices(
  daemonPort: number = DEFAULT_DAEMON_PORT
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = request(
      `http://localhost:${daemonPort}/_lohost/services`,
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("Invalid response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

export async function stopDaemon(
  daemonPort: number = DEFAULT_DAEMON_PORT
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      `http://localhost:${daemonPort}/_lohost/stop`,
      { method: "POST" },
      (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          reject(new Error("Failed to stop daemon"));
        }
      }
    );
    req.on("error", reject);
    req.end();
  });
}

export async function checkDaemonRunning(
  daemonPort: number = DEFAULT_DAEMON_PORT
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      `http://localhost:${daemonPort}/_lohost/health`,
      { timeout: 500 },
      (res) => resolve(res.statusCode === 200)
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}
