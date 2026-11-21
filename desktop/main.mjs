// Entry of the orrery desktop shell (docs/desktop.md). Order: the single-instance lock first (a second shell only
// brings the first to the front: it starts no Hub and loads no FFI), then the window and the Hub (`--ensure`), and only
// then windows the user picks. Closing the window leaves the Hub running.
import { app, dialog, shell as electronShell } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopUpdater } from './lib/desktop-update.mjs';
import { chromiumSwitches } from './lib/startup.mjs';
import { runtimeConfig, stopInstalledHub } from './lib/runtime.mjs';

// `--user-data-dir=<dir>` (used by tests and smoke runs) also moves the shell's own state and lock.
// Keep installed settings and the single-instance lock in their existing directory after the display name changes.
const userData = app.commandLine.getSwitchValue('user-data-dir');
if (userData) app.setPath('userData', userData);
else if (app.isPackaged && process.platform === 'win32') {
  const previousData = join(app.getPath('appData'), 'Orrery Beta');
  mkdirSync(previousData, { recursive: true });
  app.setPath('userData', previousData);
}
// Chromium reads these only before 'ready'.
for (const s of chromiumSwitches(process.env)) app.commandLine.appendSwitch(s);
const runtime = runtimeConfig({ packaged: app.isPackaged, resourcesPath: process.resourcesPath,
  userData: app.getPath('userData'), node: app.commandLine.getSwitchValue('orrery-node') });

if (app.isPackaged && app.commandLine.hasSwitch('orrery-quit-for-update')) {
  // Before the single-instance lock and Win32 loading: the installer may run this alongside the existing GUI.
  stopInstalledHub(runtime).then(() => app.exit(0), (e) => { console.error(e.message); app.exit(1); });
} else if (process.platform !== 'win32') {
  app.whenReady().then(() => { dialog.showErrorBox('orrery', 'orrery 桌面版只支持 Windows。'); app.exit(1); });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('window-all-closed', () => app.quit());
  // Not a top-level await: Electron emits 'ready' only after this module has finished evaluating.
  app.whenReady().then(async () => {
    const { ffi } = await import('./lib/win32.mjs');
    const { runEnsure, startShell } = await import('./shell.mjs');
    const makeUpdater = app.isPackaged ? (onChange) => createDesktopUpdater({
      currentVersion: app.getVersion(),
      tempRoot: app.getPath('temp'),
      openInstaller: (file) => electronShell.openPath(file),
      onChange,
    }) : null;
    const shell = startShell({ ffi, ensure: () => runEnsure(runtime), makeUpdater });
    app.on('second-instance', () => shell.focus());
  });
}
