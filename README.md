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

## DNS Resolution

macOS doesn't resolve `*.localhost` by default. lohost includes a DYLD interposition library that makes `*.localhost` resolve to `127.0.0.1` for any program.

### Automatic DNS (Recommended)

When running commands through lohost, DNS interception is automatic:

```bash
lohost -n myapp npm run dev  # DNS just works
```

### Manual DNS for Standalone Programs

For programs not launched through lohost:

```bash
# Set environment variable
export DYLD_INSERT_LIBRARIES=/path/to/lohost/dylib/liblohost_dns_full.dylib

# Now any program will resolve *.localhost to 127.0.0.1
node my-script.js
python my-script.py
bun my-script.ts
```

### DNS Compatibility

| Runtime | Status | Notes |
|---------|--------|-------|
| Node.js | ✅ Works | Via `getaddrinfo` hook |
| Python | ✅ Works | Via `getaddrinfo` hook |
| Bun | ✅ Works | Via `dlsym` hook for async DNS |
| Ruby (Homebrew) | ✅ Works | Via `getaddrinfo` hook |
| C/C++/Rust | ✅ Works | Via `getaddrinfo` hook |
| curl 8.x | ✅ Native | Has RFC 6761 support built-in |
| Go | ⚠️ Limited | Static DNS, needs `CGO_ENABLED=1` |
| System binaries | ❌ SIP | `/usr/bin/*` blocked by macOS SIP |

### Debug DNS

```bash
LOHOST_DEBUG=1 DYLD_INSERT_LIBRARIES=./dylib/liblohost_dns_full.dylib node -e \
  "require('dns').lookup('test.localhost', console.log)"
# [lohost-dns] getaddrinfo: intercepted test.localhost -> 127.0.0.1
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

## API Endpoints

The daemon exposes a REST API at `/_lohost/`:

```bash
curl localhost:8080/_lohost/health      # Health check
curl localhost:8080/_lohost/services    # List services
open http://lohost.localhost:8080       # Dashboard
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

## Cloudflare Workers / workerd

Cloudflare's workerd runtime can't resolve `*.localhost`. Use undici with a custom DNS lookup:

```typescript
import { Agent, setGlobalDispatcher, fetch as undiciFetch } from 'undici';

const dnsRewriteAgent = new Agent({
  connect: {
    lookup: (hostname, options, callback) => {
      if (hostname.endsWith('.localhost')) {
        callback(null, [{ address: '127.0.0.1', family: 4 }]);
        return;
      }
      lookup(hostname, { ...options, all: true }, callback);
    },
  },
});

setGlobalDispatcher(dnsRewriteAgent);
```

## Building

```bash
# TypeScript
npm install
npm run build

# DNS dylib (macOS only)
cd dylib
clang -dynamiclib -arch arm64 -arch x86_64 \
  -isysroot $(xcrun --show-sdk-path) \
  -o liblohost_dns_full.dylib lohost_dns_full.c
```

## Architecture

```
lohost/
├── src/
│   ├── index.ts      # CLI entry point
│   ├── daemon.ts     # HTTP proxy daemon
│   └── client.ts     # Client that runs commands
├── dylib/
│   ├── lohost_dns_full.c      # DNS interposition (macOS)
│   └── liblohost_dns_full.dylib
└── dist/             # Compiled JS
```

### DNS Interposition Design

The dylib uses Mach-O `__DATA,__interpose` section to hook:

1. **`getaddrinfo`** - Synchronous DNS (Node.js, Python, C)
2. **`dlsym`** - Intercepts Bun loading `getaddrinfo_async_start`

When a `*.localhost` lookup occurs, it returns `127.0.0.1` immediately. All other domains fall through to real DNS.

## Requirements

- Node.js 18+
- macOS (DNS dylib is macOS-specific)

## License

MIT
