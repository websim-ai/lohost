# DYLD DNS Interposition

Internal documentation for the macOS DNS interception mechanism used by lohost.

## Problem

macOS does not resolve `*.localhost` subdomains by default. When a program calls `getaddrinfo("foo.localhost", ...)`, macOS returns `EAI_NONAME` (hostname not found).

RFC 6761 reserves `.localhost` for loopback, but macOS's resolver doesn't implement this.

## Solution

Use DYLD interposition to hook DNS resolution functions at the dynamic linker level. When a `*.localhost` lookup occurs, return `127.0.0.1` immediately without hitting the resolver.

## Implementation

### File: `dylib/lohost_dns_full.c`

The dylib hooks two functions using Mach-O `__DATA,__interpose` sections:

#### 1. `getaddrinfo` Hook

Most programs (Node.js, Python, C) use libc's synchronous `getaddrinfo()`:

```c
int hooked_getaddrinfo(const char *node, const char *service,
                       const struct addrinfo *hints,
                       struct addrinfo **res) {
    if (is_localhost_domain(node)) {
        // Return synthetic 127.0.0.1 result
        *res = make_localhost_result(service, hints);
        return 0;
    }
    // Fall through to real getaddrinfo
    return getaddrinfo(node, service, hints, res);
}
```

#### 2. `dlsym` Hook (for Bun)

Bun on macOS uses Apple's private libinfo async DNS API (`getaddrinfo_async_start`), loaded via `dlsym()` at runtime.

Direct interposition of `getaddrinfo_async_start` causes infinite recursion on fallthrough because `dlsym()` returns our hook instead of the real function.

**Solution**: Hook `dlsym` itself to intercept when Bun loads the async function:

```c
static getaddrinfo_async_start_fn real_async_start = NULL;

void* hooked_dlsym(void *handle, const char *symbol) {
    void *result = dlsym(handle, symbol);  // Get real function

    if (strcmp(symbol, "getaddrinfo_async_start") == 0) {
        if (result && !real_async_start) {
            real_async_start = result;  // Save real function
        }
        return hooked_getaddrinfo_async_start;  // Return our hook
    }
    return result;
}
```

Now our async hook can call `real_async_start` for non-localhost domains.

### Interpose Section

The `__DATA,__interpose` section tells dyld to replace symbols:

```c
__attribute__((used))
static struct {
    const void *replacement;
    const void *replacee;
} _interpose_getaddrinfo __attribute__((section("__DATA,__interpose"))) = {
    (const void *)hooked_getaddrinfo,
    (const void *)getaddrinfo
};
```

This is the "Monterey-style" interposition that works without `DYLD_FORCE_FLAT_NAMESPACE`.

## Building

```bash
clang -dynamiclib -arch arm64 -arch x86_64 \
  -isysroot $(xcrun --show-sdk-path) \
  -o liblohost_dns_full.dylib lohost_dns_full.c
```

Creates a universal binary (~100KB) for both Apple Silicon and Intel.

## Usage

```bash
DYLD_INSERT_LIBRARIES=/path/to/liblohost_dns_full.dylib ./program
```

For debugging:
```bash
LOHOST_DEBUG=1 DYLD_INSERT_LIBRARIES=... ./program
```

## Runtime Compatibility

| Runtime | DNS Function | Status |
|---------|--------------|--------|
| Node.js | `getaddrinfo` | Works |
| Python | `getaddrinfo` | Works |
| Bun | `getaddrinfo_async_start` via dlsym | Works |
| C/C++/Rust | `getaddrinfo` | Works |
| Ruby (Homebrew) | `getaddrinfo` | Works |
| Go | Internal DNS (static) | Limited (needs CGO_ENABLED=1) |
| System binaries | N/A | Blocked by SIP |

## Limitations

### System Integrity Protection (SIP)

macOS SIP prevents `DYLD_INSERT_LIBRARIES` from affecting:
- Binaries in `/usr/bin/`, `/bin/`, `/sbin/`
- System frameworks
- Binaries with restricted entitlements

**Workaround**: Use Homebrew-installed versions (e.g., `/opt/homebrew/bin/ruby`).

### Static Linking

Programs that statically link their DNS resolver (most Go programs) won't use our hooks.

**Workaround**: Build Go with `CGO_ENABLED=1` to use libc's resolver.

## Debug Output

With `LOHOST_DEBUG=1`:

```
[lohost-dns] FULL VERSION loaded (hooks: getaddrinfo, dlsym)
[lohost-dns] Captured real getaddrinfo_async_start at 0x1922b9e24
[lohost-dns] dlsym(getaddrinfo_async_start) -> returning our hook
[lohost-dns] getaddrinfo_async_start: node=test.localhost
[lohost-dns] getaddrinfo_async_start: intercepted test.localhost -> 127.0.0.1
```

## Design Decisions

### Why not hook `gethostbyname`?

Modern programs use `getaddrinfo`. Legacy `gethostbyname` could be added if needed.

### Why hook dlsym instead of directly interposing getaddrinfo_async_start?

Direct interposition causes infinite recursion:
1. We interpose `getaddrinfo_async_start`
2. For non-localhost, we need to call the real function
3. We call `dlsym(RTLD_NEXT, "getaddrinfo_async_start")` to get it
4. But dlsym returns our hook (because it's interposed globally)
5. Infinite loop

By hooking dlsym, we capture the real function pointer *before* returning our hook.

### Why use __DATA,__interpose instead of dlsym/dlopen?

- No need for `DYLD_FORCE_FLAT_NAMESPACE`
- Works with two-level namespace (default on macOS)
- Cleaner integration with dyld

## References

- [Apple DYLD Interposing](https://opensource.apple.com/source/dyld/)
- [fishhook](https://github.com/facebook/fishhook) - Runtime function hooking
- [RFC 6761](https://datatracker.ietf.org/doc/html/rfc6761) - Special-Use Domain Names
