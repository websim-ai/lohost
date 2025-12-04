/**
 * lohost_dns.c - DNS interposition for Linux (LD_PRELOAD)
 *
 * Hooks getaddrinfo to resolve *.localhost to 127.0.0.1.
 * Simpler than macOS version - no async API or dlsym hook needed.
 *
 * Compile: gcc -shared -fPIC -o liblohost_dns.so lohost_dns.c -ldl
 * Usage: LD_PRELOAD=/path/to/liblohost_dns.so ./program
 */

#define _GNU_SOURCE
#include <sys/socket.h>
#include <netdb.h>
#include <string.h>
#include <arpa/inet.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdarg.h>
#include <dlfcn.h>

static int (*real_getaddrinfo)(const char *node, const char *service,
                               const struct addrinfo *hints,
                               struct addrinfo **res) = NULL;

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

static struct addrinfo* make_localhost_result(const char *service,
                                               const struct addrinfo *hints) {
    struct addrinfo *ai = calloc(1, sizeof(struct addrinfo));
    if (!ai) return NULL;

    struct sockaddr_in *sa = calloc(1, sizeof(struct sockaddr_in));
    if (!sa) { free(ai); return NULL; }

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

int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **res) {
    if (!real_getaddrinfo) {
        real_getaddrinfo = dlsym(RTLD_NEXT, "getaddrinfo");
        if (!real_getaddrinfo) {
            debug_log("ERROR: Could not find real getaddrinfo");
            return EAI_SYSTEM;
        }
    }

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
    return real_getaddrinfo(node, service, hints, res);
}

__attribute__((constructor))
static void lohost_dns_init(void) {
    debug_log("Linux version loaded (hook: getaddrinfo)");
}
