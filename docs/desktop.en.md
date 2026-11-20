# Electron Desktop Shell (`desktop/`, `v0.10.0-beta.3`)

Language: [中文](desktop.md) | **English**

> **Beta Notice**: `desktop/` is part of **v0.10.0-beta.3 (Beta pre-release)**, not a stable release; window docking and layout interfaces may change.

`desktop/` is an optional Electron wrapper around the orrery collaboration UI (using the character-free orbital project icon) built on **top-level window docking** without embedding or reparenting third-party applications.

## Design: Dock Top-Level Windows, Never Embed

The shell and source launcher share the account-local Hub registry and port-conflict diagnostics. [Signed bridges](native-mode.en.md)


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

## Launching Apps from the Tab Bar

The shell is the only part of orrery that ever starts a user's app, and only on the user's own click:

- Clicking `+` in the tab bar opens the app panel right below it (a small always-on-top window of the shell, above docked app windows), one icon per supported app. If the app has one window not yet in a tab, it becomes a tab; if it has several, a menu lists them by window title for you to pick; if it is **not running**, the shell starts it.
- The launch target is looked up read-only at click time: first the program path you confirmed and saved under "App locations", if it passes this click's re-check, otherwise system sources (an MSIX app's execution alias, or a Start Menu shortcut without arguments). Launches pass no arguments and no URL protocol; neither the shell's state file, the Hub nor the collaboration page can choose the target.
- For about 20 seconds after launching, the shell looks read-only for windows of that app that appeared after the click: one window becomes a new docked tab, several are offered in a menu, none means nothing happens and nothing is retried. While starting, the icon shows "starting" and further clicks do not launch again.
- Apps are never started when the shell starts, restores tabs or loses an app; a tab that needs re-selection only lists running windows.

**App locations**: the gear in the tab bar opens the "App locations" settings, one row per app with how the shell finds it and the path a launch would use. You can "Detect" (shows the result without saving), "Use this location" (saves the detected location), "Choose program…" (pick an `.exe` in the system file dialog) or "Clear" (with confirmation). Saved paths live in the shell's own data folder and are re-checked before every use: a `.exe` on a local drive that exists, is not a link, and has a file name allowed for that app; a path that fails is treated as unset and shown as invalid. MSIX apps (Claude, ChatGPT / Codex) can only start through their own execution alias and cannot take a path. Known residual risk: other programs under the same Windows account can edit that file; the checks stop a switch to another program, arguments or URLs, but not a different file with the same name.

## Installation & Startup

The Windows x64 NSIS installer includes Node and all runtime dependencies. Launch **Orrery Beta** from its shortcut. Data is stored in `%APPDATA%/Orrery Beta/hub`; closing the window leaves Hub running. The installer stops only its own Hub before upgrade or removal, and retains the database.

For native bridges and plugins, use `<installation>/resources/node/node.exe`, files under `<installation>/resources/hub/plugins` or `resources/hub/src/bridge`. Bridges and plugins find the installed Hub through the account's Hub registry (default `%USERPROFILE%/.orrery/registry`), so the host's MCP configuration no longer needs `ORRERY_HOME`. Use expanded absolute paths in MCP JSON. The installer does not edit host settings.

Developer start:

```powershell
npm ci --prefix desktop
npm start --prefix desktop
```

- Accessibility is off by default; set `ORRERY_DESKTOP_ACCESSIBILITY=1` before launching `desktop/` if needed.
- **Verified use**: Window docking, tab switching, and restoring managed windows on normal exit have passed real-desktop checks. Coverage of mixed-DPI monitors and combinations of app minimum window sizes is more limited.

### Restart the Hub After an Official Plugin Update

Open **Settings → Plugins** on the collaboration page to [manually check for and confirm an official plugin update](plugins.en.md#update-official-plugins). When the card shows the **version after restart**, return to the collaboration page and select **Quit Orrery** in the sidebar. Confirm and wait for the Hub to stop. Close the desktop window and reopen **Orrery Beta** from its shortcut. The pending plugin version takes effect on startup.

## Build the Installer

On Windows x64, from a Git checkout:

```powershell
npm ci
npm ci --prefix desktop
npm run dist --prefix desktop
```

The build verifies the pinned official Node 24.19.0 archive and includes its license. Output: `desktop/dist/Orrery-0.10.0-beta.3-Setup-x64.exe`. Build files and caches are ignored by Git.

## Interface language

Switch between Chinese and English in desktop settings or in the collaboration page's Settings → Appearance. The shell and the collaboration page switch together at once, without reloading any page; drafts, attachments and open panels stay. The next start uses the last choice. The collaboration page only rewrites `uiLang` in its own address, and the shell only adopts a valid value from the current Hub page's main frame; the page still has no desktop permissions.
