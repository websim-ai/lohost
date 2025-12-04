# lohost Packaging Report

Analysis of packaging options for distributing lohost as a cross-platform developer tool.

## Current State

lohost consists of two components:
1. **HTTP Proxy Daemon** - TypeScript/Node.js server
2. **DNS Interposition Library** - C shared library (macOS dylib)

To be truly cross-platform, we need:
- macOS: dylib + daemon (current)
- Linux: .so + daemon (to be ported)

---

## Component Analysis

### DNS Interposition

| Platform | Mechanism | Implementation |
|----------|-----------|----------------|
| macOS | `DYLD_INSERT_LIBRARIES` | `__DATA,__interpose` section + dlsym hook |
| Linux | `LD_PRELOAD` | `dlsym(RTLD_NEXT, ...)` pattern |

**Linux is simpler**: No need for dlsym hook trick. Standard `LD_PRELOAD` pattern works:

```c
// Linux version (simpler than macOS)
static int (*real_getaddrinfo)(const char*, const char*,
                               const struct addrinfo*, struct addrinfo**);

int getaddrinfo(const char *node, ...) {
    if (!real_getaddrinfo) {
        real_getaddrinfo = dlsym(RTLD_NEXT, "getaddrinfo");
    }
    if (is_localhost_domain(node)) {
        return make_localhost_result(...);
    }
    return real_getaddrinfo(node, ...);
}
```

**Compile**: `gcc -shared -fPIC -o liblohost_dns.so lohost_dns_linux.c -ldl`

Reference: [preload-getaddrinfo](https://github.com/hdon/preload-getaddrinfo) - similar pattern for DNS interception.

### HTTP Daemon

Pure application logic. No platform-specific code needed. Can be:
- Node.js/TypeScript (current)
- Rust
- Go
- Bun-compiled binary

---

## Option Matrix

### Language Options for Daemon

| Language | Single Binary | Size | Cross-compile | Ecosystem |
|----------|---------------|------|---------------|-----------|
| **Node.js** | No (needs runtime) | N/A | N/A | npm |
| **Bun compile** | Yes | ~50MB | Yes | npm |
| **Rust** | Yes | ~5MB | Yes (cross) | cargo, npm |
| **Go** | Yes | ~10MB | Easy | npm |

### Distribution Channels

| Channel | No sudo | Cross-platform | Native code | Ease |
|---------|---------|----------------|-------------|------|
| **npm install -g** | ✅ | ✅ | Via optionalDeps | Easy |
| **Homebrew** | ✅* | macOS/Linux | ✅ | Medium |
| **GitHub Releases** | ✅ | ✅ | ✅ | Easy |
| **cargo install** | ✅ | ✅ | Compiles | Rust-only |
| **Nix flake** | ✅ | ✅ | ✅ | Complex |

*Homebrew installs to /opt/homebrew (no sudo on modern macOS)

---

## Recommendation: Hybrid Approach

### Tier 1: npm with Platform Packages (Primary)

Follow the [esbuild/swc/turbo pattern](https://github.com/evanw/esbuild/issues/789):

```
@lohost/cli              - Main package (thin wrapper)
@lohost/darwin-arm64     - macOS Apple Silicon (binary + dylib)
@lohost/darwin-x64       - macOS Intel (binary + dylib)
@lohost/linux-arm64      - Linux ARM (binary + .so)
@lohost/linux-x64        - Linux x64 (binary + .so)
```

**package.json** of `@lohost/cli`:
```json
{
  "name": "@lohost/cli",
  "bin": { "lohost": "./bin/lohost" },
  "optionalDependencies": {
    "@lohost/darwin-arm64": "1.0.0",
    "@lohost/darwin-x64": "1.0.0",
    "@lohost/linux-arm64": "1.0.0",
    "@lohost/linux-x64": "1.0.0"
  }
}
```

**bin/lohost** wrapper script:
```javascript
#!/usr/bin/env node
const { platform, arch } = process;
const pkgName = `@lohost/${platform}-${arch}`;
const { binary } = require(pkgName);
execFileSync(binary, process.argv.slice(2), { stdio: 'inherit' });
```

**Installation**: `npm install -g @lohost/cli`

### Tier 2: Homebrew Tap (macOS users)

Create `websim-ai/homebrew-tap`:

```ruby
# Formula/lohost.rb
class Lohost < Formula
  desc "Local virtual host router for development"
  homepage "https://github.com/websim-ai/lohost"
  url "https://github.com/websim-ai/lohost/releases/download/v1.0.0/lohost-darwin-arm64.tar.gz"
  sha256 "..."

  def install
    bin.install "lohost"
    lib.install "liblohost_dns.dylib"
  end
end
```

**Installation**: `brew install websim-ai/tap/lohost`

### Tier 3: GitHub Releases (Direct download)

Pre-built tarballs for each platform. CI generates on tag.

### Tier 4: Nix Flake (Nix users)

```nix
# flake.nix
{
  outputs = { self, nixpkgs }: {
    packages.x86_64-linux.default = ...;
    packages.aarch64-darwin.default = ...;
  };
}
```

**Installation**: `nix run github:websim-ai/lohost`

---

## Build System Recommendation

### Option A: Keep TypeScript + C (Minimal Change)

```
lohost/
├── src/                  # TypeScript daemon
├── native/
│   ├── darwin/           # macOS dylib source
│   └── linux/            # Linux .so source
├── scripts/
│   └── build-native.sh   # Compile native libs
└── .github/
    └── workflows/
        └── release.yml   # CI for all platforms
```

**Pros**: No rewrite, fast iteration
**Cons**: Requires Node.js runtime unless using Bun compile

### Option B: Rust Rewrite (Best Long-term)

```
lohost/
├── src/                  # Rust daemon
├── native/               # C shared libraries (same)
├── Cargo.toml
└── .github/workflows/release.yml
```

**Pros**: Single ~5MB binary, fast, type-safe
**Cons**: Rewrite effort (~2-3 days for daemon)

Reference: [Packaging Rust CLI tools](https://rust-cli.github.io/book/tutorial/packaging.html), [Cross-platform releases](https://dzfrias.dev/blog/deploy-rust-cross-platform-github-actions/)

### Option C: Bun Compile (Quick Win)

Use Bun's [single-file executable](https://bun.sh/docs/bundler/executables) feature:

```bash
# Build for all platforms
bun build --compile --target=bun-darwin-arm64 src/index.ts --outfile dist/lohost-darwin-arm64
bun build --compile --target=bun-darwin-x64 src/index.ts --outfile dist/lohost-darwin-x64
bun build --compile --target=bun-linux-x64 src/index.ts --outfile dist/lohost-linux-x64
```

**Pros**: No rewrite, single binary, cross-compile
**Cons**: ~50MB binary size, newer runtime

---

## Native Library Strategy

Native libraries (.dylib/.so) must be compiled per-platform. Options:

### 1. Compile in CI (Recommended)

GitHub Actions matrix:
```yaml
jobs:
  build-native:
    strategy:
      matrix:
        include:
          - os: macos-14
            target: darwin-arm64
          - os: macos-13
            target: darwin-x64
          - os: ubuntu-latest
            target: linux-x64
```

### 2. Compile on Install (node-gyp style)

```json
{
  "scripts": {
    "postinstall": "node scripts/build-native.js"
  }
}
```

**Pros**: Always fresh
**Cons**: Requires compiler, slow install, fails in CI

### 3. Ship All Platforms in npm Package

Include all dylib/so files, load correct one at runtime.

**Pros**: Simple
**Cons**: Package bloat (~500KB → ~2MB)

---

## Recommended Implementation Plan

### Phase 1: npm + GitHub Releases (1-2 days)

1. Port DNS interposition to Linux (LD_PRELOAD)
2. Set up GitHub Actions for cross-platform builds
3. Create `@lohost/cli` with optionalDependencies
4. Publish to npm

### Phase 2: Homebrew Tap (0.5 days)

1. Create `websim-ai/homebrew-tap` repo
2. Add Formula pointing to GitHub releases
3. Test `brew install websim-ai/tap/lohost`

### Phase 3: Bun Compile or Rust (Optional, 1-3 days)

If Node.js dependency is annoying:
- **Quick**: Use Bun compile for single binary
- **Better**: Rewrite daemon in Rust

### Phase 4: Nix Flake (Optional, 0.5 days)

For Nix users and reproducible builds.

---

## Build Tooling Comparison

| Tool | Use Case | Complexity | When to Use |
|------|----------|------------|-------------|
| **Make/Just** | Simple builds | Low | Current state |
| **GitHub Actions** | CI/CD | Medium | Required for releases |
| **Nix** | Reproducible builds | High | If team uses Nix |
| **Bazel** | Monorepo, hermetic | Very High | Overkill for lohost |

**Recommendation**: Stick with Just + GitHub Actions. Nix optional.

---

## Final Recommendation

**Start with: npm platform packages + GitHub Actions**

1. **Keep TypeScript** for now (minimal change)
2. **Use Bun compile** if you want single binary without rewrite
3. **Port to Rust** later if performance/size matters
4. **Skip Bazel** - too complex for this project
5. **Add Nix flake** only if you personally use Nix

The esbuild pattern (platform-specific npm packages) is battle-tested and works great for developer tools with native components.

---

## Sources

- [esbuild platform-specific packages](https://github.com/evanw/esbuild/issues/789)
- [Rust CLI packaging](https://rust-cli.github.io/book/tutorial/packaging.html)
- [Cross-platform Rust releases](https://dzfrias.dev/blog/deploy-rust-cross-platform-github-actions/)
- [LD_PRELOAD for network analysis](https://www.bengrewell.com/analyzing-network-behaviors-of-applications-with-ld_preload/)
- [preload-getaddrinfo](https://github.com/hdon/preload-getaddrinfo)
- [Bun single-file executable](https://bun.sh/docs/bundler/executables)
- [Bun cross-compilation](https://developer.mamezou-tech.com/en/blogs/2024/05/20/bun-cross-compile/)
- [Nix Rust template](https://github.com/srid/rust-nix-template)
- [Packaging Rust with Nix](https://dev.to/misterio/how-to-package-a-rust-app-using-nix-3lh3)
