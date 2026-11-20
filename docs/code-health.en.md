# Code Health Checks

Language: [中文](code-health.md) | **English**

Knip 6.45.1 runs static dev-time checks for unreferenced files, dependencies, exports, and types without executing repository code. Versions are pinned in root `package.json` and `package-lock.json` with zero Hub runtime dependency overhead.

## Running Checks

Requires Node 24. Because `desktop/` is a separate package, Knip inspects its dependency metadata via `--ignore-scripts` without downloading or launching Electron:

```powershell
npm ci
npm ci --prefix desktop --ignore-scripts
npm run check:health
npm run check:exports
```

`check:health` treats unreferenced files, dependencies, and circular imports as errors (CI gate). `check:exports` reports candidate unused exports and types (exits 1 when present for human review; supports `--reporter json`). Neither command launches desktop shells, Hubs, native apps, or live models.

`.github/workflows/code-health.yml` installs root dependencies plus desktop metadata and runs `check:health` alongside collaboration benchmarks on `main` pushes, PRs, and manual runs.

## Entrypoints & Config

Knip automatically picks up `package.json` `main`/`exports`/`scripts` and CI commands; dynamic entrypoints and workspace boundaries live in `knip.json` across root `"."`, `desktop`, and `dsh-orrery`:

- **Root Node**: Hub, launcher, backup, Claude bridge, and `package.json`/CI dev scripts.
- **Web**: `index.html` (`app.js`, classic `theme.js`) and the dynamically loaded web entrypoints for Bookmarks, Coordinator, Star Map, and Tasks.
- **Native plugins**: Copied/externalized MCP, hook, sidecar, and background wait scripts (Antigravity's `hook-dump.mjs` is registered as a documented diagnostic entrypoint); internal modules like Cursor's `lib/hub.mjs` remain traced via imports.
- **DeepSeek plugin**: `lib/index.js` is exposed via `package.json` for external Cordis loading.
- **Examples**: Both `examples/hub-plugins` `main.mjs` files referenced in manifests.
- **Tests**: `test/*.test.ts` files executed by `scripts/test.mjs`, documented live scripts, fake CLIs spawned by path, and fixtures loaded through plugin manifests, such as `config-demo`.
- **Desktop**: `main`/`shortcut`, three preloads, three UI modules loaded directly by HTML, four standalone Electron checks, and test-spawned `win32-host` / `temp-reaper`.

Trailing `!` marks production entrypoints for `--production` export audits without replacing the full-repo report. Only OS binaries (`tasklist`, `netstat`, and optional `mkfifo` in tests) sit in `ignoreBinaries`; no blanket ignores exist. Store ad-hoc JSON reports under `.tmp`.

## Reviewing Candidates

Review callers, dynamic imports, spawned commands, external install paths, and tests before deleting flagged symbols:

- Remove `export` when a symbol is only used file-locally (unless required by an external plugin API);
- Inspect tests reading source snippets into VMs or loading modules via string paths before pruning workbench/graph/adapter test exports;
- Install desktop metadata before investigating `electron` missing-binary false positives;
- Update `knip.json` when adding HTML scripts, external plugin binaries, or string-path subprocess entrypoints.

Never run auto-fix/auto-delete scripts or add competing scanners.
