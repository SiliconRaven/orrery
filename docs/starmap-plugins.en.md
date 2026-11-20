# Embedding Plugins into Star Map (Developer Tutorial)

Starting with Orrery `0.10.0-beta.4` (Star Map `2.0.0`), Star Map is a **full-screen workspace**: built-in official plugins (`tasks`, `coordinator`, `bookmarks`) and your own third-party plugins all plug into the exact same **HUD Plugin Dock + floating window host**—with zero hard-coded privileges.

This guide walks through both supported integration paths with runnable examples, including live theme adaptation across **Luna**, **Astra**, and **Sol**.

---

## 1. Choose the Right Integration Path

Orrery enforces two plugin trust tiers, each with a matching Star Map integration surface:

| Dimension | Option A: Restricted plugin `positions: ["starmap"]` (Recommended default) | Option B: Full-trust plugin `panel` slot |
|---|---|---|
| **Best for** | 95% of third-party plugins: counters, dashboards, log viewers, CI/deploy widgets, search panels | Deep extensions that share same-page host helpers or need a `global` panel across all clusters |
| **Rendering host** | Sandboxed `<iframe sandbox="allow-scripts">` (opaque origin, strict CSP, no cookies or storage) | Same-page DOM inside `.smw-panel`, inheriting CSS tokens and `panelCtx` |
| **Theme sync** | Receives all 14 standard color tokens + `theme.starmap.theme` via `orrery.init` & `orrery.theme` | Inherits `--starmap-*` plus remapped `--bg` / `--surface` / `--accent` tokens, plus `panelCtx.onThemeChange` |
| **Scope** | Per-cluster grant (appears in clusters where the user granted `starmap`) | `scope: 'cluster'` (inside a cluster) or `scope: 'global'` (universe / galaxy / cluster) |
| **Security boundary** | `postMessage` ↔ Hub ↔ plugin process; non-removable "Third-party plugin" badge in window chrome | Same-page & Hub-equivalent trust (explicit user confirmation in Settings → Plugins); still badged as third-party |
| **Runnable example** | [`examples/hub-plugins/ui-demo/`](../examples/hub-plugins/ui-demo/) | [`examples/hub-plugins/trusted-demo/`](../examples/hub-plugins/trusted-demo/) |

> **Default to Option A (Restricted plugin)** whenever possible—it requires less code, enforces strict iframe isolation, and never asks users for full trust.

---

## 2. Option A: Embed a Restricted Plugin in 5 Minutes (Recommended)

A restricted plugin only needs 3 small changes to appear in the Star Map HUD Dock.

### Step 1: Declare `"starmap"` in `orrery-plugin.json`

Include `"ui.show"` in `permissions` and add `"starmap"` to `ui.positions`:

```json
{
  "id": "ui-demo",
  "version": "1.0.0",
  "name": "UI Demo",
  "description": "Counter panel in the title bar, task workbench, and Star Map floating window.",
  "apiVersion": 1,
  "entry": "main.mjs",
  "permissions": ["ui.show"],
  "commands": [],
  "ui": {
    "positions": ["titlebar", "workbench", "starmap"],
    "panelHeight": 240
  }
}
```

### Step 2: Grant `"starmap"` in User Configuration

Users explicitly grant `"starmap"` in the install dialog or in `ORRERY_HOME/external-plugins.json` (**previously installed plugins never receive `"starmap"` automatically**):

```json
{
  "plugins": [{
    "manifest": "C:/plugins/ui-demo/orrery-plugin.json",
    "permissions": ["ui.show"],
    "ui": ["titlebar", "workbench", "starmap"],
    "clusterIds": ["<full-cluster-id>"]
  }]
}
```

After restarting the Hub, Settings → Plugins displays **Star Map panel** as granted, and the plugin's master UI switch immediately toggles it on or off.

### Step 3: Handle `orrery.init` and `orrery.theme` in `ui/app.js`

Star Map reuses the exact same `postMessage` protocol as `titlebar` and `workbench`:

```js
function applyTheme(theme) {
  const root = document.documentElement;
  root.style.colorScheme = theme.scheme; // always 'dark' inside Star Map
  for (const [token, colour] of Object.entries(theme.colors ?? {})) {
    root.style.setProperty(`--${token}`, colour);
  }
  const starmapTheme = theme?.starmap?.theme; // 'luna' | 'astra' | 'sol'
  if (starmapTheme) root.dataset.starmapTheme = starmapTheme;
}

addEventListener('message', (event) => {
  if (event.source !== parent) return;
  const msg = event.data;
  if (msg?.type === 'orrery.init') {
    applyTheme(msg.theme);
    parent.postMessage({ type: 'orrery.request', id: 'init-1', data: { action: 'get' } }, '*');
  } else if (msg?.type === 'orrery.theme') {
    // Pushed live whenever the user switches Luna / Astra / Sol in Star Map
    applyTheme(msg.theme);
  } else if (msg?.type === 'orrery.push') {
    renderCount(msg.data.count);
  }
});

parent.postMessage({ type: 'orrery.ready' }, '*');
```

As long as your `ui/style.css` consumes the 14 standard CSS tokens (`--bg`, `--surface`, `--surface-2`, `--line`, `--text`, `--muted`, `--accent`, `--accent-soft`, `--on-accent`, `--running`, `--done`, `--failed`, `--warn-bg`, `--warn-text`), your panel adapts automatically to all three Star Map themes.

See the complete runnable example in [`examples/hub-plugins/ui-demo/`](../examples/hub-plugins/ui-demo/).

---

## 3. Option B: Full-Trust `panel` Slot

A full-trust (or official) plugin can return a `panel` descriptor (or non-empty array of descriptors) from `register(host)` in its web entry (`web/index.js`):

```js
export function register({ api, ui, onDispose }) {
  const { h } = ui;
  // Keep per-window state keyed by container `el` so cluster-scoped panels can open in multiple clusters at once.
  const cleanups = new Map();
  const detach = (el) => {
    if (el) { cleanups.get(el)?.(); cleanups.delete(el); return; }
    for (const fn of cleanups.values()) fn();
    cleanups.clear();
  };

  return {
    panel: {
      id: 'notes',                      // unique per plugin (^[a-z][a-z0-9-]*$)
      title: () => 'Cluster Notes',     // plain text or function returning plain text
      icon: 'file',                     // must match an existing sprite symbol i-<name>
      scope: 'cluster',                 // 'cluster' or 'global'
      defaultSize: { w: 460, h: 400 },  // optional initial dimensions (clamped to viewport)
      badge: (clusterId) => null,       // optional short badge text/count on the Dock button
      mount(el, panelCtx) {
        detach(el);
        let alive = true;
        const box = h('div', { style: 'padding: 12px;' }, 'Loading…');
        el.replaceChildren(box);

        const stopTheme = panelCtx.onThemeChange((theme) => {
          box.dataset.theme = theme.id; // 'luna' | 'astra' | 'sol'
        });

        const stopEvents = panelCtx.onEvent((ev) => {
          if (ev.clusterId === panelCtx.clusterId) { /* refresh */ }
        });

        panelCtx.api('GET', `/api/x/my-plugin/clusters/${encodeURIComponent(panelCtx.clusterId)}/notes`)
          .then((data) => { if (alive) box.textContent = `${data.notes.length} notes`; })
          .catch((err) => { if (alive) box.textContent = err.message; });

        const cleanup = () => {
          alive = false;
          stopTheme();
          stopEvents();
        };
        cleanups.set(el, cleanup);
        return () => detach(el);
      },
      unmount(el) {
        detach(el);
      },
    },
  };
}
```

### `panelCtx` Reference

Every method is guarded by the window's active lifecycle; closing the window, leaving Star Map, or detaching the plugin disables all handles and aborts in-flight `GET`/`HEAD` requests:

| Field | Description |
|---|---|
| `clusterId` | Active cluster ID (`null` for `scope: 'global'`) |
| `api(method, path, body?)` | Authenticated Hub API helper; aborts pending reads on close |
| `onEvent(fn)` | Subscribes to the page SSE event stream; auto-unsubscribed on close |
| `theme` | `{ id: 'luna' \| 'astra' \| 'sol', scheme: 'dark', tokens: Record<string, string> }` |
| `onThemeChange(fn)` | Fires when the user switches Star Map themes; returns unsubscribe function |
| `setTitle(text)` / `setSubtitle(text)` | Updates floating window title/subtitle as plain text |
| `close()` | Closes this floating window |
| `openCluster(clusterId)` | Flies the Star Map camera to the given cluster |
| `openMember(clusterId, memberId)` | Opens the member's conversation window in Star Map |

### Allowed Sprite Icons & Theme Tokens

- `icon` must match an existing page sprite symbol (`tasks`, `users`, `star`, `file`, `folder`, `search`, `chats`, `comment`, `layers`, `chip`, `clock`, `orbit`, `alert`, `gear`, `trash`, `help`). Raw HTML/SVG strings are rejected.
- Inside `.smw-panel`, standard UI tokens (`--bg`, `--surface`, `--surface-2`, `--line`, `--text`, `--muted`, `--accent`, `--accent-soft`, `--on-accent`) are automatically remapped to the active Star Map theme, and all `--starmap-*` tokens (`--starmap-glass`, `--starmap-edge`, `--starmap-edge-strong`, `--starmap-radius`, `--starmap-ether`, etc.) are available directly.

See [`examples/hub-plugins/trusted-demo/`](../examples/hub-plugins/trusted-demo/) for the complete runnable example.

---

## 4. Security & Troubleshooting Checklist

1. **Restricted plugin does not show up in the Star Map Dock?**
   - Confirm `permissions` includes `"ui.show"` and `ui.positions` includes `"starmap"` in `orrery-plugin.json`;
   - Confirm the user grant (`external-plugins.json` or install wizard) explicitly includes `"starmap"` and the current cluster ID;
   - Confirm the plugin's UI master switch is ON in Settings → Plugins and its runtime state is `ready`;
   - Fly into a cluster (star system level)—per-cluster restricted panels only appear inside their granted clusters.
2. **Iframe stays blank or times out?**
   - Ensure `ui/index.html` exists inside the plugin directory and loads no external network assets (strict CSP blocks remote scripts/images);
   - Ensure your script posts `{ type: 'orrery.ready' }` to `parent` after registering its `message` listener.
3. **Full-trust `panel` slot was rejected?**
   - Check the browser console: `plugin-slots.js` validates every field synchronously (no unknown keys, valid lowercase `id`, unique `id`, whitelisted sprite `icon`, `scope` in `['cluster', 'global']`, no Promise return values);
   - Build DOM with `host.ui.h()` rather than `innerHTML`, and release listeners/timers in both `unmount()` and `host.onDispose()`;
   - The host automatically tags panel containers with `data-plugin-slot="<id>"` so unsent drafts are preserved on leave or detach.
4. **Private DM isolation**: Restricted plugins never see 1-on-1 Star Map private DMs (`private: true`) or their delivery/guard events; see [external-plugins.en.md](external-plugins.en.md) and [security.en.md](security.en.md).
