# lohost - Local virtual host router for development
#
# Routes *.localhost:8080 to registered projects.

[private]
default:
    @just --list

# Start the lohost daemon (port 8080 by default)
daemon:
    pnpm run daemon

# Show status of all registered projects
status:
    pnpm exec tsx src/index.ts status

# Register a project with lohost (allocates ports)
register PROJECT:
    pnpm exec tsx src/index.ts register {{PROJECT}}

# Run a command wrapped with lohost registration
run *ARGS:
    pnpm exec tsx src/index.ts run {{ARGS}}

# Build the TypeScript
build:
    pnpm run build

# Run linting
[group('check')]
lint *ARGS:
    pnpm run lint {{ARGS}}

# Run type checking
[group('check')]
typecheck *ARGS:
    pnpm run typecheck {{ARGS}}

# Run all checks
[group('check'), parallel]
check: lint typecheck
