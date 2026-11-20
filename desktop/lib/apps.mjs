// Supported apps for the desktop shell (docs/desktop.md): display name + process image file name. Pure data and one
// lookup; imports nothing, so the root `npm test` can load it without Electron or the FFI library.
//
// The image file name must belong to a top-level app window; helper and installer names are not aliases:
//   - Claude Desktop: MSIX app\Claude.exe (file names compare without case).
//   - ChatGPT / Codex: MSIX app/ChatGPT.exe. The neighboring app\Codex.exe is a windowless stub.
//   - DeepSeek Harness and Kimi Code use DeepSeek Harness.exe and Kimi Code.exe. Kimi.exe is the separate chat app.
//   - ZCode, Antigravity, Qoder, WorkBuddy and Cursor use their app-named .exe. Their helper processes may have the
//     same image name but own no top-level window. Qoder installer and launcher image names are separate.
//   - Cursor can expose several top-level windows for its workspaces and Agents view.
//
// Installation lookup is read-only (lib/locate.mjs): the shell reads the icon from an installed app and starts it
// only after a user click in the strip (docs/desktop.md "启动应用"). Claude and ChatGPT / Codex are MSIX packages:
// `package` is their public package family name and `appId` the Application Id in their package manifest whose
// Executable is `exe`; they are started like the Start menu does, by app ID (`package!appId`). `alias` is only read
// to find the installed package and its program (the icon); it is never started. Other apps are found through
// Start Menu shortcuts. Qoder can point at its own launcher, `starter`; WorkBuddy and Cursor point at their app exe.

/**
 * @typedef {{ id: string, name: string, exe: string, package?: string, appId?: string, alias?: string, starter?: string }} App
 *   exe: the image file name of the app's windows; package + appId + alias: an MSIX app's family name, the Application
 *   Id it is started by, and its execution alias;
 *   starter: another image file name the app's own Start Menu shortcut may point at instead of `exe`
 */

/** @type {readonly App[]} */
export const APPS = Object.freeze([
  { id: 'claude', name: 'Claude', exe: 'Claude.exe', package: 'Claude_pzs8sxrjxfjjc', appId: 'Claude', alias: 'claude-desktop.exe' },
  { id: 'codex', name: 'ChatGPT / Codex', exe: 'ChatGPT.exe', package: 'OpenAI.Codex_2p2nqsd0c76g0', appId: 'App', alias: 'chatgpt-desktop.exe' },
  { id: 'deepseek', name: 'DeepSeek Harness', exe: 'DeepSeek Harness.exe' },
  { id: 'kimi-code', name: 'Kimi Code', exe: 'Kimi Code.exe' },
  { id: 'zcode', name: 'ZCode', exe: 'ZCode.exe' },
  { id: 'antigravity', name: 'Antigravity', exe: 'Antigravity.exe' },
  { id: 'qoder', name: 'Qoder', exe: 'Qoder.exe', starter: 'Qoder Launcher.exe' },
  { id: 'workbuddy', name: 'WorkBuddy', exe: 'WorkBuddy.exe' },
  { id: 'cursor', name: 'Cursor', exe: 'Cursor.exe' },
].map((a) => Object.freeze(a)));

/** The last segment of a Windows or POSIX path. */
export const fileName = (path) => String(path).split(/[\\/]/).pop() ?? '';

/**
 * The supported app whose image file name (any case) ends this image path, or null.
 * @param {string} imagePath
 * @param {readonly App[]} [apps]
 * @returns {App | null}
 */
export function appForImage(imagePath, apps = APPS) {
  const name = fileName(imagePath).toLowerCase();
  return name ? apps.find((a) => a.exe.toLowerCase() === name) ?? null : null;
}
