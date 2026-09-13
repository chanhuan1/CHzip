# Contributing to chzip

## Architecture Overview

chzip is a fnOS third-party app built with Node.js (≥22) and zero runtime
dependencies. It uses fnOS's CGI-per-request model for third-party apps.

### Request Flow

```
fnOS File Manager (right-click)
        │
        ▼
   index.cgi  ──── serves static www/ files (HTML/CSS/JS)
        │
        ▼
    api.cgi  ──── bash shim → exec node api.js
                    │
                    ├── QUERY_STRING → api name (info/preview/extract/...)
                    ├── stdin → JSON body
                    └── stdout → JSON response
```

### Directory Structure

```
chzip/
├── app/
│   ├── server/              # Backend (Node.js CGI)
│   │   ├── api.js           # CGI entry point + router
│   │   ├── sync-authorized-paths.js
│   │   └── lib/             # 20 library modules
│   │       ├── archive.js        # Format/volume classification
│   │       ├── archive-service.js # Archive inspection
│   │       ├── authorization-paths.js
│   │       ├── constants.js      # Timeouts, limits, permission modes
│   │       ├── diagnostic-service.js # Diagnostic report builder
│   │       ├── diagnostics.js    # Logging + redaction
│   │       ├── engine.js         # 7-Zip spawn + error classification
│   │       ├── fs-utils.js       # Shared lock/write utilities
│   │       ├── jobs.js           # Job store, locking, cancellation
│   │       ├── listing-validator.js
│   │       ├── nested.js         # Nested tar handling
│   │       ├── paths.js          # Directory authorization + traversal
│   │       ├── preview.js        # 7z technical-list parser
│   │       ├── selection.js      # Selected-path validation
│   │       ├── sevenzip.js       # 7z CLI arg builder
│   │       ├── services.js       # Service composition root
│   │       ├── source.js         # File fingerprinting
│   │       ├── source-access.js  # Source file inspection
│   │       ├── watcher.js        # Directory watching + archive detection
│   │       └── worker.js         # Background extraction worker
│   ├── ui/                  # CGI shell scripts
│   ├── www/                 # Frontend (vanilla JS, no framework)
│   └── vendor/7zip/         # Bundled 7zzs binaries
├── cmd/                     # fnOS lifecycle scripts
├── config/                  # App privilege/resource config
├── scripts/                 # Build + audit scripts
├── tests/                   # Unit tests
├── manifest                 # fnOS app manifest
└── package.json
```

### Key Design Decisions

- **Zero npm dependencies** — only Node.js built-ins
- **File-based job store** with atomic writes and file-locking
- **No framework** — vanilla JS frontend, IIFE modules, no build step
- **Dependency injection** — `createServices()` accepts overrides for testing

## Development Setup

### Prerequisites

- Node.js ≥ 22
- 7-Zip (optional, for local testing)

### Running Tests

```bash
npm test
```

This runs all unit tests in the `tests/` directory using Node's built-in test runner.

### Building the FPK Package

```bash
# Build for current platform
node scripts/build-fpk.js --platform x86

# Build for all platforms and variants
node scripts/build-fpk.js --platform all --variant all

# Build without fnpack (stage only)
node scripts/build-fpk.js --stage-only
```

The `fnpack` tool is required for actual packaging. Set `FNPACK_PATH` if it's not
on your `PATH`.

### Build Variants

- `search-fixed` — Full build with file search enabled (only variant)

## Code Style

- Use `"use strict";` at the top of every file
- Use `const`/`let`, never `var`
- Use `Object.hasOwn()` instead of `hasOwnProperty` directly
- Prefer `node:` prefix for built-in modules (`node:fs`, `node:crypto`, etc.)
- Use JSDoc-style comments for public functions

## Security Considerations

- All user-controlled paths are validated through `normalizeEntryPath()`
- Passwords are never passed via command-line args (use password files)
- Passwords are masked in the UI by default
- Request bodies are capped at 16 MiB
- All file writes use atomic rename patterns
- Diagnostics redact sensitive values

## Adding a New Archive Format

1. Add the format pattern to `SINGLE_FORMATS` in `app/server/lib/archive.js`
2. Add a test case in `tests/archive.test.js`
3. Run `npm test` to verify

## Release Checklist

1. Bump the version in **four** places — there is no single source of truth,
   and the manifest version is what actually ships:
   - `manifest` — `version = X.Y`
   - `package.json` — `"version": "X.Y"` (not read by the build, easy to miss)
   - `app/www/index.html` — asset cache-busting `?v=X.Y` (1 CSS + 12 JS).
     Leave the brand icon at `?v=1.0.0` unless that file itself changed.
   - `scripts/audit-fpk.js` — the two `fileName` assertions and the manifest
     version regex
2. Run `npm test`
3. Build: `node scripts/build-fpk.js --platform all --variant all`.
   Make sure `build/staging/` is empty first — the script's recursive cleanup
   deletes ~70 files at once and trips the bulk-delete safety hook (threshold
   50), which yields no artifacts at all. Move the contents aside instead.
4. Move any older `.fpk` out of `dist/`, then
   `cd dist && shasum -a 256 *.fpk > SHA256SUMS.txt` (otherwise the glob pulls
   historical versions into the checksum file).
5. Verify: `npm run test:release` (requires the built FPK files). Note it does
   **not** check icons or UI features — only manifest version/platform, 7-Zip
   arch + ELF machine, font hashes and CSS font declarations. For UI changes,
   unpack `app.tgz` and verify those separately.
