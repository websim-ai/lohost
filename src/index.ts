#!/usr/bin/env node
/**
 * lohost - Local virtual host router for development
 *
 * Usage:
 *   lohost -n <name> -- <command>   Run command with UDS proxy (auto-starts daemon)
 *   lohost daemon [--stop]          Start or stop the daemon
 *   lohost list                     List registered projects
 */

import { parseArgs } from "node:util";
import { LohostClient, listServices, stopDaemon, checkDaemonRunning } from "./client.js";
import { LohostDaemon } from "./daemon.js";

const DEFAULT_PORT = 8080;
const DEFAULT_ROUTE_DOMAIN = "localhost";

const HELP = `lohost - Local virtual host router for development

Usage:
  lohost -n <name> -- <command>   Run command with allocated port
  lohost daemon                   Start the routing daemon
  lohost daemon --stop            Stop the routing daemon
  lohost list                     List registered projects
  lohost help                     Show this help

Options:
  -n, --name <name>      Project name (required for run mode)
  -d, --socket-dir <dir> Socket directory (default: /tmp)
  -p, --port <port>      Daemon port (default: 8080)
  -h, --help             Show this help

Environment:
  LOHOST_PORT            Daemon port (default: 8080)
  LOHOST_ROUTE_DOMAIN    Routing domain (default: localhost)

Routing:
  {name}.localhost:8080           → /tmp/{name}.sock
  {sub}.{name}.localhost:8080     → /tmp/{name}.sock (subdomain passed through)

Host header transformation:
  user1.myapp.localhost:8080  →  Backend sees: user1.myapp.localhost:{PORT}

Example:
  lohost -n api -- node server.js
  # Server gets PORT=54321
  # Browser: http://api.localhost:8080 → routes to your server
  # Backend receives Host: api.localhost:54321
`;

async function main() {
  const args = process.argv.slice(2);

  // Handle subcommands first
  if (args[0] === "daemon") {
    await runDaemon(args.slice(1));
    return;
  }

  if (args[0] === "list") {
    await runList();
    return;
  }

  if (args[0] === "help" || args.length === 0) {
    console.log(HELP);
    return;
  }

  // Parse client mode args
  const { values, positionals } = parseArgs({
    args,
    options: {
      name: { type: "string", short: "n" },
      "socket-dir": { type: "string", short: "d", default: "/tmp" },
      port: { type: "string", short: "p" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  if (!values.name) {
    console.error("Error: --name is required\n");
    console.error("Usage: lohost -n <name> -- <command>");
    process.exit(1);
  }

  if (positionals.length === 0) {
    console.error("Error: command is required\n");
    console.error("Usage: lohost -n <name> -- <command>");
    process.exit(1);
  }

  const [command, ...cmdArgs] = positionals;
  const daemonPort = parseInt(
    values.port ?? process.env.LOHOST_PORT ?? String(DEFAULT_PORT),
    10
  );

  const client = new LohostClient({
    name: values.name,
    socketDir: values["socket-dir"],
    daemonPort,
  });

  const exitCode = await client.run(command, cmdArgs);
  process.exit(exitCode);
}

async function runDaemon(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      stop: { type: "boolean" },
      port: { type: "string", short: "p" },
    },
    strict: true,
  });

  const port = parseInt(
    values.port ?? process.env.LOHOST_PORT ?? String(DEFAULT_PORT),
    10
  );

  if (values.stop) {
    const running = await checkDaemonRunning(port);
    if (!running) {
      console.log("Daemon is not running");
      return;
    }
    await stopDaemon(port);
    console.log("Daemon stopped");
    return;
  }

  const routeDomain = process.env.LOHOST_ROUTE_DOMAIN ?? DEFAULT_ROUTE_DOMAIN;
  const daemon = new LohostDaemon({ port, routeDomain });

  try {
    await daemon.start();
    console.error(`[lohostd] Listening on http://localhost:${port}`);
    console.error(`[lohostd] Routes: http://<name>.${routeDomain}:${port}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("already in use")) {
      console.error(`[lohostd] Port ${port} already in use (daemon may already be running)`);
      process.exit(1);
    }
    throw err;
  }

  process.on("SIGINT", () => {
    console.error("\n[lohostd] Shutting down...");
    daemon.stop().then(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    daemon.stop().then(() => process.exit(0));
  });
}

async function runList(): Promise<void> {
  const port = parseInt(process.env.LOHOST_PORT ?? String(DEFAULT_PORT), 10);

  const running = await checkDaemonRunning(port);
  if (!running) {
    console.log("Daemon is not running");
    return;
  }

  const services = (await listServices(port)) as Array<{
    name: string;
    socketPath: string;
    url: string;
  }>;

  if (services.length === 0) {
    console.log("No registered services");
    return;
  }

  console.log("NAME".padEnd(20) + "URL");
  console.log("-".repeat(50));
  for (const s of services) {
    console.log(s.name.padEnd(20) + s.url);
  }
}

main().catch((err) => {
  console.error("lohost error:", err.message);
  process.exit(1);
});
