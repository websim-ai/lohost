#!/bin/bash
# Build native DNS interposition libraries for lohost
#
# Usage:
#   ./build.sh              # Build for current platform
#   ./build.sh darwin-arm64 # Build for specific target
#   ./build.sh darwin-x64
#   ./build.sh linux-x64
#   ./build.sh linux-arm64
#   ./build.sh all          # Build all (requires cross-compile toolchain)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

build_darwin() {
    local arch="$1"
    echo "Building for darwin-$arch..."

    clang -dynamiclib -arch "$arch" \
        -isysroot "$(xcrun --show-sdk-path)" \
        -o "liblohost_dns.dylib" \
        darwin/lohost_dns.c

    echo "Built: liblohost_dns.dylib (darwin-$arch)"
}

build_linux() {
    local arch="$1"
    echo "Building for linux-$arch..."

    if [ "$arch" = "arm64" ] && [ "$(uname -m)" != "aarch64" ]; then
        # Cross-compile for ARM64
        aarch64-linux-gnu-gcc -shared -fPIC \
            -o "liblohost_dns.so" \
            linux/lohost_dns.c -ldl
    else
        gcc -shared -fPIC \
            -o "liblohost_dns.so" \
            linux/lohost_dns.c -ldl
    fi

    echo "Built: liblohost_dns.so (linux-$arch)"
}

build_darwin_universal() {
    echo "Building universal darwin binary..."

    clang -dynamiclib -arch arm64 -arch x86_64 \
        -isysroot "$(xcrun --show-sdk-path)" \
        -o "liblohost_dns.dylib" \
        darwin/lohost_dns.c

    echo "Built: liblohost_dns.dylib (universal)"
}

case "${1:-auto}" in
    darwin-arm64)
        build_darwin arm64
        ;;
    darwin-x64)
        build_darwin x86_64
        ;;
    darwin-universal)
        build_darwin_universal
        ;;
    linux-x64)
        build_linux x64
        ;;
    linux-arm64)
        build_linux arm64
        ;;
    all)
        echo "Building all targets..."
        build_darwin_universal
        # Linux builds require cross-compilation or running on Linux
        if [ "$(uname)" = "Linux" ]; then
            build_linux x64
        fi
        ;;
    auto)
        # Auto-detect platform
        case "$(uname -s)-$(uname -m)" in
            Darwin-arm64)
                build_darwin arm64
                ;;
            Darwin-x86_64)
                build_darwin x86_64
                ;;
            Linux-x86_64)
                build_linux x64
                ;;
            Linux-aarch64)
                build_linux arm64
                ;;
            *)
                echo "Unsupported platform: $(uname -s)-$(uname -m)"
                exit 1
                ;;
        esac
        ;;
    *)
        echo "Usage: $0 [darwin-arm64|darwin-x64|darwin-universal|linux-x64|linux-arm64|all|auto]"
        exit 1
        ;;
esac

echo "Done."
