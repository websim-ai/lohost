# lohost Release Guide

Step-by-step guide for releasing new versions of lohost to npm.

## Overview

lohost uses a multi-package release strategy:

```
lohost                    ← Main package (TypeScript CLI + daemon)
@lohost/darwin-arm64      ← macOS Apple Silicon native library
@lohost/darwin-x64        ← macOS Intel native library
@lohost/linux-x64         ← Linux x64 native library
@lohost/linux-arm64       ← Linux ARM64 native library
```

When you push a version tag (e.g., `v0.0.1`), GitHub Actions:
1. Builds native libraries on each platform
2. Publishes platform packages to npm
3. Publishes main package to npm
4. Creates a GitHub Release with downloadable tarballs

---

## Prerequisites

### 1. npm Account and Organization

```bash
# Login to npm
npm login

# Verify you're logged in
npm whoami
```

You need publish access to:
- `lohost` package
- `@lohost` organization (for scoped packages)

To create the organization (first time only):
1. Go to https://www.npmjs.com/org/create
2. Create `@lohost` organization
3. Add any collaborators

### 2. GitHub Repository Secrets

Add the following secret to the repository:

| Secret | Description | How to get it |
|--------|-------------|---------------|
| `NPM_TOKEN` | npm automation token | npm → Account → Access Tokens → Generate New Token (Automation) |

To add the secret:
1. Go to repository Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Name: `NPM_TOKEN`, Value: your token

### 3. Local Development Setup

```bash
cd ~/wbsm/lohost
npm install
npm run build
```

---

## Pre-Release Checklist

### 1. Update Version Numbers

All packages must have the same version. Update these files:

```bash
# Main package
# package.json → "version": "X.Y.Z"

# Platform packages (all 4)
# packages/darwin-arm64/package.json → "version": "X.Y.Z"
# packages/darwin-x64/package.json → "version": "X.Y.Z"
# packages/linux-x64/package.json → "version": "X.Y.Z"
# packages/linux-arm64/package.json → "version": "X.Y.Z"

# Also update optionalDependencies in main package.json to match
```

Quick version bump script:
```bash
VERSION="0.0.2"

# Update main package
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" package.json

# Update platform packages
for pkg in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
  sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" packages/$pkg/package.json
done

# Update optionalDependencies references
sed -i '' "s/@lohost\/darwin-arm64\": \".*\"/@lohost\/darwin-arm64\": \"$VERSION\"/" package.json
sed -i '' "s/@lohost\/darwin-x64\": \".*\"/@lohost\/darwin-x64\": \"$VERSION\"/" package.json
sed -i '' "s/@lohost\/linux-x64\": \".*\"/@lohost\/linux-x64\": \"$VERSION\"/" package.json
sed -i '' "s/@lohost\/linux-arm64\": \".*\"/@lohost\/linux-arm64\": \"$VERSION\"/" package.json
```

### 2. Update VERSION Constant

Update the version in `src/daemon.ts`:
```typescript
const VERSION = "X.Y.Z";
```

### 3. Test Locally

```bash
# Build TypeScript
npm run build

# Test daemon starts
node dist/index.js daemon &
curl http://localhost:8080/_lohost/health
# Should return: {"status":"ok","version":"X.Y.Z",...}

# Kill daemon
curl -X POST http://localhost:8080/_lohost/stop

# Test native library build (if you have Xcode)
cd native && ./build.sh && cd ..

# Test with native library (macOS)
DYLD_INSERT_LIBRARIES=./native/liblohost_dns.dylib \
  node -e "require('dns').lookup('test.localhost', console.log)"
# Should resolve to 127.0.0.1
```

### 4. Run Type Check

```bash
npm run typecheck
```

### 5. Review Changes

```bash
git diff
git status
```

---

## Release Process

### 1. Commit Version Bump

```bash
git add package.json packages/*/package.json src/daemon.ts
git commit -m "Bump version to X.Y.Z"
```

### 2. Push to Main

```bash
git push origin main
```

### 3. Create and Push Tag

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

### 4. Monitor GitHub Actions

1. Go to repository → Actions tab
2. Watch the "Release" workflow
3. It should:
   - Build native libraries on 4 platforms
   - Publish `@lohost/darwin-arm64` to npm
   - Publish `@lohost/darwin-x64` to npm
   - Publish `@lohost/linux-x64` to npm
   - Publish `@lohost/linux-arm64` to npm
   - Publish `lohost` to npm
   - Create GitHub Release

---

## Post-Release Verification

### 1. Verify npm Packages

```bash
# Check main package
npm view lohost

# Check platform packages
npm view @lohost/darwin-arm64
npm view @lohost/darwin-x64
npm view @lohost/linux-x64
npm view @lohost/linux-arm64
```

### 2. Test Installation

```bash
# Create temp directory
cd $(mktemp -d)

# Install globally
npm install -g lohost

# Verify version
lohost --version  # or check help

# Test daemon
lohost daemon &
curl http://localhost:8080/_lohost/health
lohost daemon --stop

# Clean up
npm uninstall -g lohost
```

### 3. Check GitHub Release

1. Go to repository → Releases
2. Verify release was created with correct tag
3. Verify tarballs are attached

---

## Troubleshooting

### npm Publish Fails with 403

**Cause**: Missing npm token or insufficient permissions.

**Fix**:
1. Verify `NPM_TOKEN` secret is set correctly
2. Ensure token has publish permissions
3. Ensure you have access to `@lohost` org

### Platform Package Already Exists

**Cause**: Re-running release with same version.

**Fix**: The workflow uses `|| echo "Failed..."` to continue on duplicate publish. This is expected for re-runs.

To truly re-publish:
1. Unpublish the version: `npm unpublish @lohost/darwin-arm64@X.Y.Z`
2. Wait 24 hours (npm policy) or bump version

### Native Build Fails

**macOS**: Check that the runner has Xcode command line tools.
**Linux ARM64**: Uses cross-compilation with `aarch64-linux-gnu-gcc`.

Check the build logs in GitHub Actions for specific errors.

### TypeScript Build Fails

```bash
# Check locally
npm run typecheck

# Common issues:
# - Missing imports
# - Type errors in new code
```

---

## Version Strategy

Follow semantic versioning:

| Version | When to use |
|---------|-------------|
| `0.0.x` | Pre-release, breaking changes expected |
| `0.x.0` | Feature additions, API changes |
| `x.0.0` | Major releases, production ready |

Current: `0.0.x` (pre-release phase)

---

## Manual Release (Emergency)

If CI fails, you can release manually:

### 1. Build Native Libraries Locally

```bash
# On macOS ARM64 machine
cd native && ./build.sh darwin-arm64
cp liblohost_dns.dylib ../packages/darwin-arm64/

# On macOS Intel machine (or Rosetta)
cd native && ./build.sh darwin-x64
cp liblohost_dns.dylib ../packages/darwin-x64/

# On Linux x64 machine
cd native && ./build.sh linux-x64
cp liblohost_dns.so ../packages/linux-x64/

# On Linux ARM64 machine (or cross-compile)
cd native && ./build.sh linux-arm64
cp liblohost_dns.so ../packages/linux-arm64/
```

### 2. Publish Platform Packages

```bash
cd packages/darwin-arm64 && npm publish --access public && cd ../..
cd packages/darwin-x64 && npm publish --access public && cd ../..
cd packages/linux-x64 && npm publish --access public && cd ../..
cd packages/linux-arm64 && npm publish --access public && cd ../..
```

### 3. Publish Main Package

```bash
npm run build
npm publish --access public
```

### 4. Create GitHub Release Manually

1. Go to repository → Releases → Draft new release
2. Choose your tag
3. Auto-generate release notes
4. Attach any tarballs manually

---

## Files Changed in a Release

Typical files modified for a version bump:

```
package.json                           # Main version + optionalDeps
packages/darwin-arm64/package.json     # Platform version
packages/darwin-x64/package.json       # Platform version
packages/linux-x64/package.json        # Platform version
packages/linux-arm64/package.json      # Platform version
src/daemon.ts                          # VERSION constant
```

---

## Quick Reference

```bash
# Bump version
VERSION="0.0.2"
# ... (run version bump commands above)

# Commit and tag
git add -A
git commit -m "Release v$VERSION"
git push origin main
git tag v$VERSION
git push origin v$VERSION

# Watch CI
open https://github.com/websim-ai/lohost/actions

# Verify
npm view lohost
```
