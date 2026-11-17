# Launcher & Instance Discovery (`launcher.ts`)

Language: [中文](launcher.md) | **English**

The launcher safely probes or starts a local Hub and opens the collaboration UI with session credentials (`--ensure` exposes the same probe/start workflow for the desktop shell).

## Commands

| Command | Behavior |
|---|---|
| `npm start` | Starts the Hub in the foreground |
| `npm run open` | Probes for a matching Hub, starts one detached if absent, waits until healthy, and opens the browser |
| `npm run open -- --ensure` | Runs the same probe/start flow and prints a single JSON line (`{"url"}` or `{"error"}`) without opening a browser |
| `npm run shortcut` | Creates a Windows desktop launcher shortcut |

## Configuration & Probe Behavior

`resolveConfig()` resolves `ORRERY_PORT` (default `4317`), `ORRERY_HOME` (default `~/.orrery`), and `ORRERY_DB` (default `<repo>/.tmp/orrery.db`). Tests must specify separate ports and paths to avoid the daily `4317` Hub.

- **No directory lock or PID cleanup**: The launcher maintains no directory lock files and never inspects or cleans dead PIDs; mutual exclusion relies on Hub port binding.
- **Same-data reuse across ports**: Reads `<ORRERY_HOME>/hub.json` (URL + PID) and probes that URL's `GET /api/health` with the API token:
  1. If `/api/health` confirms `app === 'orrery'`, matching `pid`, and matching `(home, db)` paths, the launcher **reuses that Hub even if its port differs from current `ORRERY_PORT`**;
  2. If another data directory owns the Hub (`other-data`), auth fails (`401` -> `unauthorized`), or health status is unreadable (`unknown`), the launcher aborts cleanly without hijacking or killing anything;
  3. Only on `none` (missing/stale `hub.json`, `ECONNREFUSED`, non-orrery, or mismatched PID) does it spawn a background Hub and poll `/api/health` up to **20s (`START_TIMEOUT_MS`)**. On timeout, it reports an error with `<ORRERY_HOME>/hub.log` and exits **without terminating the background Hub** (which may still be finishing startup).

## Auth & Shutdown Boundary

- **Browser session setup**: Launches `<url>/#token=<apiToken>` (URL fragments stay out of HTTP logs); the page calls `POST /api/session` to set an `HttpOnly`, `SameSite=Strict` cookie (no one-time token consumption limit). Static root assets return `200`, while all `/api/*` endpoints—including `GET /api/health`—return `401` without valid credentials.
- **Authenticated shutdown (`POST /api/shutdown`)**: Gracefully stops only after API auth succeeds. The launcher never stops or kills processes.
