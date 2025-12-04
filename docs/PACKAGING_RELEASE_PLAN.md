# lohost v0.0.1 Release Plan

Comprehensive plan for the first npm release of lohost.

## Package Structure

```
npm:
  lohost                     ← Main package (TypeScript daemon + CLI)
  @lohost/darwin-arm64       ← macOS Apple Silicon native lib
  @lohost/darwin-x64         ← macOS Intel native lib
  @lohost/linux-x64          ← Linux x64 native lib
  @lohost/linux-arm64        ← Linux ARM native lib
```

**Installation**: `npm install -g lohost`

---

## Pre-Release Changes

### 1. Remove Dashboard, Add JSON API

Current: Dashboard HTML at `http://lohost.localhost:8080`
Target: Pure JSON API at `/_lohost/*`

#### API Endpoints (v0.0.1)

| Endpoint | Method | Response |
|----------|--------|----------|
| `/_lohost/health` | GET | `{ "status": "ok", "uptime": 12345 }` |
| `/_lohost/services` | GET | `[{ "name": "...", "port": ..., "url": "..." }]` |
| `/_lohost/services/:name` | GET | `{ "name": "...", "port": ..., "url": "...", "socketPath": "..." }` |
| `/_lohost/config` | GET | `{ "port": 8080, "routeDomain": "localhost" }` |

#### Changes to daemon.ts

```typescript
// REMOVE: Dashboard HTML rendering
// REMOVE: Static file serving
// REMOVE: HTML templates

// KEEP: JSON API handlers
// ADD: Structured error responses
// ADD: CORS headers for local dev tools
```

#### Files to modify:
- [ ] `src/daemon.ts` - Remove dashboard, clean up API responses
- [ ] `README.md` - Update API documentation

### 2. Port DNS Interposition to Linux

#### Create `native/linux/lohost_dns.c`

```c
// Linux version - simpler than macOS (no dlsym trick needed)
#define _GNU_SOURCE
#include <dlfcn.h>
#include <netdb.h>
#include <string.h>
#include <arpa/inet.h>
#include <stdlib.h>

static int (*real_getaddrinfo)(const char*, const char*,
                               const struct addrinfo*, struct addrinfo**) = NULL;

static int is_localhost_domain(const char *hostname) {
    if (!hostname) return 0;
    size_t len = strlen(hostname);
    return (len >= 10 && strcmp(hostname + len - 10, ".localhost") == 0);
}

int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **res) {
    if (!real_getaddrinfo) {
        real_getaddrinfo = dlsym(RTLD_NEXT, "getaddrinfo");
    }

    if (is_localhost_domain(node)) {
        // Return synthetic 127.0.0.1 result
        // (same logic as macOS version)
    }

    return real_getaddrinfo(node, service, hints, res);
}
```

Compile: `gcc -shared -fPIC -o liblohost_dns.so lohost_dns.c -ldl`

#### Directory structure:
```
native/
├── darwin/
│   └── lohost_dns.c      ← Current macOS version (move from dylib/)
├── linux/
│   └── lohost_dns.c      ← New Linux version
└── build.sh              ← Cross-platform build script
```

### 3. Add Native Library Loading to CLI

#### Modify `src/client.ts`

```typescript
import { createRequire } from 'module';
import { platform, arch } from 'os';
import { dirname, join } from 'path';

function getNativeLibPath(): string | null {
  const plat = platform();
  const ar = arch();

  // Map to package names
  const platformMap: Record<string, string> = {
    'darwin-arm64': '@lohost/darwin-arm64',
    'darwin-x64': '@lohost/darwin-x64',
    'linux-x64': '@lohost/linux-x64',
    'linux-arm64': '@lohost/linux-arm64',
  };

  const pkgName = platformMap[`${plat}-${ar}`];
  if (!pkgName) return null;

  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve(`${pkgName}/package.json`);
    const dir = dirname(pkgPath);
    const ext = plat === 'darwin' ? 'dylib' : 'so';
    return join(dir, `liblohost_dns.${ext}`);
  } catch {
    return null; // Platform package not installed
  }
}

function getPreloadEnv(): Record<string, string> {
  const libPath = getNativeLibPath();
  if (!libPath) return {};

  const envVar = platform() === 'darwin'
    ? 'DYLD_INSERT_LIBRARIES'
    : 'LD_PRELOAD';

  return { [envVar]: libPath };
}
```

### 4. Update package.json for Main Package

```json
{
  "name": "lohost",
  "version": "0.0.1",
  "description": "Local virtual host router for development",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "lohost": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build"
  },
  "files": [
    "dist"
  ],
  "optionalDependencies": {
    "@lohost/darwin-arm64": "0.0.1",
    "@lohost/darwin-x64": "0.0.1",
    "@lohost/linux-x64": "0.0.1",
    "@lohost/linux-arm64": "0.0.1"
  },
  "engines": {
    "node": ">=18"
  },
  "keywords": [
    "localhost",
    "proxy",
    "virtual-host",
    "development",
    "dns"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/websim-ai/lohost.git"
  },
  "license": "MIT"
}
```

### 5. Create Platform Package Structure

Each platform package follows this structure:

```
packages/
├── darwin-arm64/
│   ├── package.json
│   └── liblohost_dns.dylib
├── darwin-x64/
│   ├── package.json
│   └── liblohost_dns.dylib
├── linux-x64/
│   ├── package.json
│   └── liblohost_dns.so
└── linux-arm64/
    ├── package.json
    └── liblohost_dns.so
```

#### Platform package.json template:

```json
{
  "name": "@lohost/darwin-arm64",
  "version": "0.0.1",
  "description": "lohost native library for macOS ARM64",
  "os": ["darwin"],
  "cpu": ["arm64"],
  "files": ["liblohost_dns.dylib"],
  "repository": {
    "type": "git",
    "url": "https://github.com/websim-ai/lohost.git"
  },
  "license": "MIT"
}
```

---

## Repository Structure (Final)

```
lohost/
├── src/
│   ├── index.ts           # CLI entry point
│   ├── daemon.ts          # HTTP proxy daemon (no dashboard)
│   └── client.ts          # Client with native lib loading
├── native/
│   ├── darwin/
│   │   └── lohost_dns.c   # macOS source
│   ├── linux/
│   │   └── lohost_dns.c   # Linux source
│   └── build.sh           # Build script
├── packages/              # Platform-specific npm packages
│   ├── darwin-arm64/
│   ├── darwin-x64/
│   ├── linux-x64/
│   └── linux-arm64/
├── .github/
│   └── workflows/
│       └── release.yml    # CI for building & publishing
├── docs/
│   ├── DYLD_DNS_INTERPOSITION.md
│   ├── PACKAGING_REPORT.md
│   └── PACKAGING_RELEASE_PLAN.md
├── package.json
├── tsconfig.json
├── justfile
└── README.md
```

---

## GitHub Actions Workflow

### `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build-native:
    strategy:
      matrix:
        include:
          - os: macos-14
            target: darwin-arm64
            ext: dylib
          - os: macos-13
            target: darwin-x64
            ext: dylib
          - os: ubuntu-latest
            target: linux-x64
            ext: so
          - os: ubuntu-latest
            target: linux-arm64
            ext: so
            cross: true

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - name: Build native library
        run: |
          cd native
          if [ "${{ matrix.cross }}" = "true" ]; then
            # Cross-compile for ARM
            sudo apt-get install -y gcc-aarch64-linux-gnu
            aarch64-linux-gnu-gcc -shared -fPIC \
              -o liblohost_dns.so linux/lohost_dns.c -ldl
          else
            ./build.sh ${{ matrix.target }}
          fi

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: native-${{ matrix.target }}
          path: native/liblohost_dns.${{ matrix.ext }}

  publish:
    needs: build-native
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - name: Download all artifacts
        uses: actions/download-artifact@v4
        with:
          path: artifacts

      - name: Prepare platform packages
        run: |
          for target in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
            mkdir -p packages/$target
            cp artifacts/native-$target/* packages/$target/
          done

      - name: Publish platform packages
        run: |
          for dir in packages/*/; do
            cd "$dir"
            npm publish --access public
            cd ../..
          done
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Build main package
        run: npm ci && npm run build

      - name: Publish main package
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

## Release Checklist

### Phase 1: Code Changes (Day 1)

- [ ] **Remove dashboard from daemon.ts**
  - [ ] Remove HTML template
  - [ ] Remove static file serving
  - [ ] Keep JSON API endpoints
  - [ ] Add CORS headers
  - [ ] Add `/config` endpoint

- [ ] **Port DNS to Linux**
  - [ ] Create `native/linux/lohost_dns.c`
  - [ ] Test on Linux (Docker or VM)
  - [ ] Create `native/build.sh`

- [ ] **Add native lib loading**
  - [ ] Modify `client.ts` to load platform package
  - [ ] Handle missing platform gracefully
  - [ ] Set correct env var (DYLD_INSERT_LIBRARIES vs LD_PRELOAD)

- [ ] **Restructure repo**
  - [ ] Move `dylib/lohost_dns_full.c` → `native/darwin/lohost_dns.c`
  - [ ] Create `packages/` directory structure
  - [ ] Update `.gitignore`

### Phase 2: Package Setup (Day 1)

- [ ] **Update main package.json**
  - [ ] Add optionalDependencies
  - [ ] Add repository, keywords
  - [ ] Set version to 0.0.1

- [ ] **Create platform package.json files**
  - [ ] darwin-arm64
  - [ ] darwin-x64
  - [ ] linux-x64
  - [ ] linux-arm64

- [ ] **Update README.md**
  - [ ] Installation instructions
  - [ ] API documentation (no dashboard)
  - [ ] Platform support table

### Phase 3: CI/CD Setup (Day 2)

- [ ] **Set up GitHub Actions**
  - [ ] Create release.yml workflow
  - [ ] Test workflow with dry-run

- [ ] **npm setup**
  - [ ] Create @lohost org on npm
  - [ ] Generate NPM_TOKEN
  - [ ] Add to GitHub secrets

### Phase 4: Release (Day 2)

- [ ] **Final testing**
  - [ ] Test on macOS ARM
  - [ ] Test on macOS Intel (Rosetta or real)
  - [ ] Test on Linux x64 (Docker)

- [ ] **Tag and release**
  ```bash
  git tag v0.0.1
  git push origin v0.0.1
  ```

- [ ] **Verify**
  - [ ] Check npm packages published
  - [ ] Test `npm install -g lohost`
  - [ ] Test on fresh machine

---

## API Documentation (v0.0.1)

### GET /_lohost/health

```json
{
  "status": "ok",
  "version": "0.0.1",
  "uptime": 12345
}
```

### GET /_lohost/services

```json
[
  {
    "name": "frontend",
    "port": 10000,
    "socketPath": "/tmp/frontend.sock",
    "url": "http://frontend.localhost:8080"
  },
  {
    "name": "api",
    "port": 10001,
    "socketPath": "/tmp/api.sock",
    "url": "http://api.localhost:8080"
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

Or 404:
```json
{
  "error": "Service not found",
  "name": "unknown"
}
```

### GET /_lohost/config

```json
{
  "port": 8080,
  "routeDomain": "localhost",
  "socketDir": "/tmp",
  "version": "0.0.1"
}
```

---

## Post-Release (v0.0.2+)

- [ ] Dashboard as separate optional package (`lohost-dashboard`)
- [ ] WebSocket for real-time service updates
- [ ] Service health checks
- [ ] Request logging/metrics
- [ ] Windows support (if needed)

---

## Notes

### Why remove dashboard for v0.0.1?

1. **Simpler first release** - Focus on core functionality
2. **API-first** - Dashboard can be built separately
3. **Smaller package** - No HTML/CSS/JS assets
4. **Easier testing** - Just curl the API

### Why not Windows?

1. No `LD_PRELOAD` equivalent that works universally
2. Windows DNS hooking requires different approach (Detours, etc.)
3. Can add later if demand exists

### Version strategy

- `0.0.x` - Pre-release, breaking changes expected
- `0.1.0` - First "stable" release
- `1.0.0` - Production ready
