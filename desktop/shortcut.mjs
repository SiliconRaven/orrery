// `npm run shortcut` in desktop/: writes "orrery 桌面版.lnk" on the Desktop, which starts this shell with Electron and
// tells it which Node runs the Hub launcher (the Node this command ran with). Same approach as the launcher's
// `npm run shortcut` (src/launcher.ts createShortcut): PowerShell's WScript.Shell, every path and name passed in
// environment variables, never inside the script. Only when the user runs the command; the existing "orrery"
// shortcut is left alone.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const DESKTOP_DIR = import.meta.dirname;
export const SHORTCUT_NAME = 'orrery 桌面版.lnk';

// WScript.Shell goes through the ANSI code page, so a name like "桌面版" turns into "???": the shortcut is saved
// under an ASCII name first and then renamed by PowerShell, which handles Unicode names. The description is ASCII.
// shortcut: a target or repository path with characters outside the ANSI code page would be mangled the same way;
// switch to IShellLinkW if that ever matters.
export const SHORTCUT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "$dir = [Environment]::GetFolderPath('Desktop')",
  '$path = Join-Path $dir $env:ORRERY_SHORTCUT_NAME',
  "$tmp = Join-Path $dir ('orrery-desktop-' + [guid]::NewGuid().ToString('N') + '.lnk')",
  '$existed = Test-Path -LiteralPath $path',
  '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($tmp)',
  '$s.TargetPath = $env:ORRERY_SHORTCUT_TARGET',
  '$s.Arguments = $env:ORRERY_SHORTCUT_ARGUMENTS',
  '$s.WorkingDirectory = $env:ORRERY_SHORTCUT_DIR',
  '$s.Description = $env:ORRERY_SHORTCUT_DESCRIPTION',
  '$s.IconLocation = $env:ORRERY_SHORTCUT_ICON',
  '$s.Save()',
  'Move-Item -LiteralPath $tmp -Destination $path -Force',
  "if ($existed) { 'replaced|' + $path } else { 'created|' + $path }",
].join('; ');

/** Runs a PowerShell script with -NoProfile -NonInteractive; values reach it only as environment variables. */
export const runPowerShell = (script, vars) => new Promise((done) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...vars }, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
  child.once('error', () => done({ code: null, stdout }));
  child.once('close', (code) => done({ code, stdout }));
});

/** The shortcut's target and arguments: Electron, this directory as the app, and the Node for the launcher. */
export function shortcutVars({ electron, node, desktopDir = DESKTOP_DIR }) {
  return {
    ORRERY_SHORTCUT_NAME: SHORTCUT_NAME,
    ORRERY_SHORTCUT_TARGET: electron,
    ORRERY_SHORTCUT_ARGUMENTS: `"${desktopDir}" "--orrery-node=${node}"`,
    ORRERY_SHORTCUT_DIR: desktopDir,
    ORRERY_SHORTCUT_DESCRIPTION: 'orrery desktop',
    ORRERY_SHORTCUT_ICON: join(desktopDir, 'assets', 'orrery-icon.ico'),
  };
}

export async function createDesktopShortcut({ electron, node = process.execPath, desktopDir = DESKTOP_DIR, run = runPowerShell, platform = process.platform } = {}) {
  if (platform !== 'win32') {
    console.log('orrery 桌面版只支持 Windows。');
    return 1;
  }
  const r = await run(SHORTCUT_SCRIPT, shortcutVars({ electron, node, desktopDir }));
  const [status, path] = r.stdout.trim().split('|');
  if (r.code !== 0 || !path) {
    console.error('创建桌面快捷方式失败（见上面 PowerShell 的输出）。');
    return 1;
  }
  console.log(status === 'replaced' ? `已覆盖桌面上原有的快捷方式：${path}` : `已在桌面创建快捷方式：${path}`);
  console.log('Node 换了安装位置、仓库移动或重新安装依赖以后，要在 desktop 目录里重新运行一次 npm run shortcut。');
  return 0;
}

if (import.meta.main) {
  // In plain Node, the electron package resolves to the path of electron.exe; it downloads the runtime first if it is
  // not there yet (npm ci does not fetch it).
  const electron = createRequire(import.meta.url)('electron');
  process.exit(await createDesktopShortcut({ electron }));
}
