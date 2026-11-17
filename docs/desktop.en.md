# Electron Desktop Shell (`desktop/`, `v0.10.0-beta.1`)

Language: [中文](desktop.md) | **English**

> **Beta Notice**: `desktop/` is part of **v0.10.0-beta.1 (Beta pre-release)**, not a stable release; window docking and layout interfaces may change.

`desktop/` is an optional Electron wrapper around the orrery collaboration UI (using the character-free orbital project icon) built on **top-level window docking** without embedding or reparenting third-party applications.

## Design: Dock Top-Level Windows, Never Embed

Reparenting third-party apps via `BrowserView` or Win32 `SetParent` triggers focus stealing, DPI clipping, and boundary issues. The shell acts purely as a coordinator frame:

- Renders the authenticated collaboration UI inside the shell;
- Lets the user explicitly select running allowlisted windows from the `+` tab strip, synchronizing position, dimensions, and Z-order via `koffi` Win32 FFI calls;
- Supports **single-pane, dual-column, and 2x2 quad** split layouts.

## Allowlisted Apps & Security Boundaries

Allowlisted apps are maintained in `desktop/lib/apps.mjs`:

1. **Per-write window verification**: Before moving or resizing any window, the shell verifies process executable and window identity; stale or closed windows enter rebind state requiring explicit user re-selection.
2. **User-triggered launch separation (MSIX vs non-MSIX)**: When clicking an allowlisted offline app in `+`, launches pass zero extra flags and zero URL schemes:
   - **Store apps (MSIX packages)**: Launch **strictly through their Windows `AppExecutionAlias`**; `checkProgram` explicitly refuses saving manual `.exe` paths for MSIX apps (manual paths cannot bypass alias lookup failures).
   - **Non-MSIX desktop apps**: Checks any local `.exe` saved in trusted shell settings (`checkProgram` enforces local drive `.exe`, no `..`, `%`, or symlinks/aliases, matching allowlisted filename), falling back to read-only parameterless Start Menu shortcuts.
3. **Token-separated settings (`checkProgram`)**: Trusted settings calls authorize via in-process shell tokens; neither the web collaboration view nor any Hub API holds Electron main-process or Win32 privileges.
4. **Clean-exit restore**: Restores managed top-level windows without closing external applications.

## Installation & Startup

The Windows x64 NSIS installer includes Node and all runtime dependencies. Launch **Orrery Beta** from its shortcut. Data is stored in `%APPDATA%/Orrery Beta/hub`; closing the window leaves Hub running. The installer stops only its own Hub before upgrade or removal, and retains the database.

For native bridges and plugins, use `<installation>/resources/node/node.exe`, files under `<installation>/resources/hub/plugins` or `resources/hub/src/bridge`, and set `ORRERY_HOME` to `%APPDATA%/Orrery Beta/hub` in the host's MCP configuration. Use expanded absolute paths in MCP JSON. The installer does not edit host settings.

Developer start:

```powershell
npm ci --prefix desktop
npm start --prefix desktop
```

- Accessibility is off by default; set `ORRERY_DESKTOP_ACCESSIBILITY=1` before launching `desktop/` if needed.
- **Verified use**: Window docking, tab switching, and restoring managed windows on normal exit have passed real-desktop checks. Coverage of mixed-DPI monitors and combinations of app minimum window sizes is more limited.

## Build the Installer

On Windows x64, from a Git checkout:

```powershell
npm ci
npm ci --prefix desktop
npm run dist --prefix desktop
```

The build verifies the pinned official Node 24.19.0 archive and includes its license. Output: `desktop/dist/Orrery-0.10.0-beta.1-Setup-x64.exe`. Build files and caches are ignored by Git.
