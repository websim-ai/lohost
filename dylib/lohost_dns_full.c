/**
 * lohost_dns_full.c - Full DNS interposition including libinfo async API
 *
 * Hooks:
 * - getaddrinfo (libc synchronous)
 * - dlsym (to intercept Bun's loading of getaddrinfo_async_start)
 */

#include <sys/socket.h>
#include <netdb.h>
#include <string.h>
#include <arpa/inet.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdarg.h>
#include <dlfcn.h>
#include <mach/mach.h>

static void debug_log(const char *fmt, ...) {
    if (getenv("LOHOST_DEBUG") == NULL) return;
    va_list args;
    va_start(args, fmt);
    fprintf(stderr, "[lohost-dns] ");
    vfprintf(stderr, fmt, args);
    fprintf(stderr, "\n");
    va_end(args);
}

static int is_localhost_domain(const char *hostname) {
    if (!hostname) return 0;
    size_t len = strlen(hostname);
    if (len >= 10 && strcmp(hostname + len - 10, ".localhost") == 0) {
        return 1;
    }
    return 0;
}

// ============ Synchronous getaddrinfo hook ============

static struct addrinfo* make_localhost_result(const char *service,
                                               const struct addrinfo *hints) {
    struct addrinfo *ai = calloc(1, sizeof(struct addrinfo));
    if (!ai) return NULL;

    struct sockaddr_in *sa = calloc(1, sizeof(struct sockaddr_in));
    if (!sa) { free(ai); return NULL; }

    sa->sin_len = sizeof(struct sockaddr_in);
    sa->sin_family = AF_INET;
    inet_pton(AF_INET, "127.0.0.1", &sa->sin_addr);
    if (service) {
        int port = atoi(service);
        sa->sin_port = htons(port > 0 ? port : 0);
    }

    ai->ai_flags = hints ? hints->ai_flags : 0;
    ai->ai_family = AF_INET;
    ai->ai_socktype = hints ? hints->ai_socktype : SOCK_STREAM;
    ai->ai_protocol = hints ? hints->ai_protocol : IPPROTO_TCP;
    if (ai->ai_socktype == 0) ai->ai_socktype = SOCK_STREAM;
    if (ai->ai_protocol == 0) ai->ai_protocol = IPPROTO_TCP;
    ai->ai_addrlen = sizeof(struct sockaddr_in);
    ai->ai_addr = (struct sockaddr *)sa;
    ai->ai_canonname = NULL;
    ai->ai_next = NULL;

    return ai;
}

int hooked_getaddrinfo(const char *node, const char *service,
                       const struct addrinfo *hints,
                       struct addrinfo **res) {
    if (is_localhost_domain(node)) {
        debug_log("getaddrinfo: intercepted %s -> 127.0.0.1", node);

        if (hints && hints->ai_family == AF_INET6) {
            goto fallthrough;
        }

        struct addrinfo *result = make_localhost_result(service, hints);
        if (result) {
            *res = result;
            return 0;
        }
    }

fallthrough:
    return getaddrinfo(node, service, hints, res);
}

// ============ Async getaddrinfo hook (libinfo) ============

typedef void (*getaddrinfo_async_callback)(int32_t status, struct addrinfo *res, void *context);

typedef int32_t (*getaddrinfo_async_start_fn)(
    mach_port_t *port,
    const char *node,
    const char *service,
    const struct addrinfo *hints,
    getaddrinfo_async_callback callback,
    void *context
);

// Store the REAL original function pointer (before any hooks)
static getaddrinfo_async_start_fn real_async_start = NULL;

// Our hook for the async function
static int32_t hooked_getaddrinfo_async_start(
    mach_port_t *port,
    const char *node,
    const char *service,
    const struct addrinfo *hints,
    getaddrinfo_async_callback callback,
    void *context
) {
    debug_log("getaddrinfo_async_start: node=%s", node ? node : "(null)");

    if (is_localhost_domain(node)) {
        debug_log("getaddrinfo_async_start: intercepted %s -> 127.0.0.1", node);

        // Create synthetic result
        struct addrinfo *result = make_localhost_result(service, hints);
        if (result) {
            // Call callback immediately with success
            if (callback) {
                callback(0, result, context);
            }
            if (port) *port = 0;
            return 0;
        }
    }

    // Call the REAL original function
    if (real_async_start) {
        return real_async_start(port, node, service, hints, callback, context);
    }

    // Fallback error
    debug_log("ERROR: No real_async_start available");
    if (callback) {
        callback(-1, NULL, context);
    }
    return -1;
}

// ============ Hook dlsym to intercept getaddrinfo_async_start lookup ============

void* hooked_dlsym(void *handle, const char *symbol) {
    // First call real dlsym
    void *result = dlsym(handle, symbol);

    // If it's the async DNS function, save the real one and return our hook
    if (symbol && strcmp(symbol, "getaddrinfo_async_start") == 0) {
        if (result && !real_async_start) {
            real_async_start = (getaddrinfo_async_start_fn)result;
            debug_log("Captured real getaddrinfo_async_start at %p", result);
        }
        debug_log("dlsym(getaddrinfo_async_start) -> returning our hook");
        return (void*)hooked_getaddrinfo_async_start;
    }

    return result;
}

// ============ Interpose definitions ============

__attribute__((used))
static struct {
    const void *replacement;
    const void *replacee;
} _interpose_getaddrinfo __attribute__((section("__DATA,__interpose"))) = {
    (const void *)hooked_getaddrinfo,
    (const void *)getaddrinfo
};

__attribute__((used))
static struct {
    const void *replacement;
    const void *replacee;
} _interpose_dlsym __attribute__((section("__DATA,__interpose"))) = {
    (const void *)hooked_dlsym,
    (const void *)dlsym
};

__attribute__((constructor))
static void lohost_dns_init(void) {
    debug_log("FULL VERSION loaded (hooks: getaddrinfo, dlsym)");
}
