# lohost

Local virtual host router for development. Run multiple local dev servers with subdomain routing.

Access each project at `<name>.localhost:8080` without port conflicts.

## Quick Start

```bash
# Install
npm install -g lohost

# Start the daemon (once, in background)
lohost daemon &

# Run your dev server
lohost -n frontend npm run dev
# → http://frontend.localhost:8080

# In another terminal
lohost -n api ./start.sh
# → http://api.localhost:8080
```

## How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser                                                            │
│                                                                     │
│  http://frontend.localhost:8080  ───┐                               │
│  http://api.localhost:8080       ───┼───►  lohost daemon (:8080)    │
│  http://user1.myapp.localhost:8080──┘      │                        │
└─────────────────────────────────────────────────────────────────────┘
                                             │
                         ┌───────────────────┼───────────────────┐
                         │                   │                   │
                         ▼                   ▼                   ▼
                 ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
                 │ frontend    │     │ api         │     │ myapp       │
                 │ PORT=10000  │     │ PORT=10003  │     │ PORT=10006  │
                 │             │     │             │     │             │
                 │ Host header:│     │ Host header:│     │ Host header:│
                 │ frontend.   │     │ api.        │     │ user1.myapp.│
                 │ localhost   │     │ localhost   │     │ localhost   │
                 └─────────────┘     └─────────────┘     └─────────────┘
```

1. **lohost daemon** runs on port 8080 as a reverse proxy
2. When you run `lohost -n <name> <command>`, it:
   - Allocates a port and sets `PORT` environment variable
   - Creates a Unix domain socket for the daemon to connect to
   - Runs your command
3. The daemon routes `*.localhost` requests by Host header
4. Routing uses the **rightmost** subdomain as the project name:
   - `user1.myapp.localhost` → project "myapp" (subdomain preserved)

## Platform Support

| Platform | DNS Mechanism | Status |
|----------|---------------|--------|
| macOS ARM64 (Apple Silicon) | `DYLD_INSERT_LIBRARIES` | ✅ |
| macOS x64 (Intel) | `DYLD_INSERT_LIBRARIES` | ✅ |
| Linux x64 | `LD_PRELOAD` | ✅ |
| Linux ARM64 | `LD_PRELOAD` | ✅ |
| Windows | N/A | ❌ Not supported |

## DNS Resolution

macOS and Linux don't always resolve `*.localhost` correctly. lohost includes native DNS interposition libraries that make `*.localhost` resolve to `127.0.0.1` for any program.

### Automatic DNS (Recommended)

When running commands through lohost, DNS interception is automatic:

```bash
lohost -n myapp npm run dev  # DNS just works
```

### DNS Compatibility

| Runtime | Status | Notes |
|---------|--------|-------|
| Node.js | ✅ Works | Via `getaddrinfo` hook |
| Python | ✅ Works | Via `getaddrinfo` hook |
| Bun | ✅ Works | Via `dlsym` hook for async DNS (macOS) |
| Ruby | ✅ Works | Via `getaddrinfo` hook |
| C/C++/Rust | ✅ Works | Via `getaddrinfo` hook |
| curl 8.x | ✅ Native | Has RFC 6761 support built-in |
| Go | ⚠️ Limited | Static DNS, needs `CGO_ENABLED=1` |
| System binaries | ❌ SIP | macOS `/usr/bin/*` blocked by SIP |

### Debug DNS

```bash
# macOS
LOHOST_DEBUG=1 lohost -n test node -e \
  "require('dns').lookup('test.localhost', console.log)"

# Output: [lohost-dns] getaddrinfo: intercepted test.localhost -> 127.0.0.1
```

## Commands

```bash
lohost daemon              # Start the routing daemon
lohost daemon --stop       # Stop the daemon
lohost -n NAME COMMAND     # Run command with allocated port
lohost list                # List active projects
lohost help                # Show help
```

## CLI Options

| Flag | Description |
|------|-------------|
| `-n, --name <name>` | Project name (required for run mode) |
| `-d, --socket-dir <dir>` | Socket directory (default: /tmp) |
| `-p, --port <port>` | Daemon port (default: 8080) |
| `-h, --help` | Show help |

## Environment Variables

**Set by lohost for your command:**

| Variable | Description |
|----------|-------------|
| `PORT` | Port your server should listen on |

**Configuration:**

| Variable | Default | Description |
|----------|---------|-------------|
| `LOHOST_PORT` | 8080 | Daemon listen port |
| `LOHOST_ROUTE_DOMAIN` | localhost | Domain for routing |

## Subdomain Routing

| URL | Routes to |
|-----|-----------|
| `myapp.localhost:8080` | project "myapp" |
| `user1.myapp.localhost:8080` | project "myapp" (subdomain passed through) |
| `api.localhost:8080` | project "api" |

## API

The daemon exposes a JSON API at `/_lohost/`:

### GET /_lohost/health

```json
{
  "status": "ok",
  "version": "0.0.1",
  "uptime": 12345,
  "services": 3
}
```

### GET /_lohost/services

```json
[
  {
    "name": "frontend",
    "port": 10000,
    "socketPath": "/tmp/frontend.sock",
    "url": "http://frontend.localhost:8080",
    "registeredAt": "2024-12-04T00:00:00Z"
  }
]
```

### GET /_lohost/services/:name

```json
{
  "name": "frontend",
  "port": 10000,
  "socketPath": "/tmp/frontend.sock",
  "url": "http://frontend.localhost:8080",
  "registeredAt": "2024-12-04T00:00:00Z"
}
```

### GET /_lohost/config

```json
{
  "version": "0.0.1",
  "port": 8080,
  "routeDomain": "localhost",
  "socketDir": "/tmp"
}
```

## Framework Integration

Most frameworks support the `PORT` environment variable:

```javascript
// Node.js / Express
app.listen(process.env.PORT || 3000)
```

```python
# Python
import os
port = int(os.environ.get('PORT', 8000))
```

```bash
# Shell
python -m http.server ${PORT:-8000}
```

## Building from Source

```bash
# Clone and install
git clone https://github.com/websim-ai/lohost.git
cd lohost
npm install
npm run build

# Build native DNS library for current platform
cd native
./build.sh
```

## Architecture

```
lohost/
├── src/
│   ├── index.ts      # CLI entry point
│   ├── daemon.ts     # HTTP proxy daemon
│   └── client.ts     # Client that runs commands
├── native/
│   ├── darwin/       # macOS DNS interposition
│   │   └── lohost_dns.c
│   ├── linux/        # Linux DNS interposition
│   │   └── lohost_dns.c
│   └── build.sh      # Build script
├── packages/         # Platform-specific npm packages
│   ├── darwin-arm64/
│   ├── darwin-x64/
│   ├── linux-x64/
│   └── linux-arm64/
└── dist/             # Compiled JS
```

### DNS Interposition Design

**macOS**: Uses Mach-O `__DATA,__interpose` section to hook:
1. **`getaddrinfo`** - Synchronous DNS (Node.js, Python, C)
2. **`dlsym`** - Intercepts Bun loading `getaddrinfo_async_start`

**Linux**: Uses `LD_PRELOAD` with `dlsym(RTLD_NEXT, ...)` to hook `getaddrinfo`.

When a `*.localhost` lookup occurs, it returns `127.0.0.1` immediately. All other domains fall through to real DNS.

## Requirements

- Node.js 18+
- macOS or Linux

## License

MIT
