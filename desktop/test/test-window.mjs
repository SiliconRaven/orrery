// Test windows for the Win32 check (docs/desktop.md test F): a small WinForms window in a PowerShell process this test
// starts itself, titled "orrery-desktop-test <nonce>", with a text box holding "unsaved input <nonce>". It reports
// its handle, window state and text every 150 ms on stdout and follows commands written to a file: max, min, normal,
// front (the window brings itself in front of the other normal windows: TopMost on, then off, without activating),
// allowfg <pid> (this test process, while it is the foreground window, lets the one process <pid>, the shell under
// test, activate itself, as a user's click on the shell would; AllowSetForegroundWindow, called here only, never by the
// shell, and never for all processes: the test windows themselves must stay without foreground rights, like real apps),
// hang <ms> (blocks its UI thread without pumping any message: Thread.Sleep, not Start-Sleep, which on this STA thread
// waits with a message-pumping wait and so still answers messages sent from other threads). ShowWithoutActivation
// keeps it from taking focus when it appears.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition '
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class OrreryTestForm : Form {
  public bool Strict;
  public int Refused;
  [StructLayout(LayoutKind.Sequential)] struct WINDOWPOS { public IntPtr hwnd; public IntPtr hwndInsertAfter; public int x; public int y; public int cx; public int cy; public uint flags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override void WndProc(ref Message m) {
    if (Strict && m.Msg == 0x46) {
      WINDOWPOS wp = (WINDOWPOS)Marshal.PtrToStructure(m.LParam, typeof(WINDOWPOS));
      if ((wp.flags & 0x4) == 0 && (wp.flags & 0x10) != 0 && GetForegroundWindow() != Handle) {
        wp.flags |= 0x4;
        Marshal.StructureToPtr(wp, m.LParam, false);
        Refused++;
      }
    }
    base.WndProc(ref m);
  }
}
'
$f = New-Object OrreryTestForm
$f.Strict = ($env:ORRERY_TEST_STRICT -eq '1')
$f.Text = $env:ORRERY_TEST_TITLE
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(80, 80)
$f.Size = New-Object System.Drawing.Size(520, 380)
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Dock = 'Fill'
$box.Text = $env:ORRERY_TEST_TEXT
$f.Controls.Add($box)
$cmdFile = $env:ORRERY_TEST_CMD
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.add_Tick({
  if (Test-Path -LiteralPath $cmdFile) {
    $c = (Get-Content -LiteralPath $cmdFile -Raw).Trim()
    Remove-Item -LiteralPath $cmdFile
    if ($c -eq 'max') { $f.WindowState = 'Maximized' }
    elseif ($c -eq 'min') { $f.WindowState = 'Minimized' }
    elseif ($c -eq 'normal') { $f.WindowState = 'Normal' }
    elseif ($c -eq 'front') { $f.TopMost = $true; $f.TopMost = $false }
    elseif ($c -like 'allowfg *') {
      $grantee = [int]$c.Substring(8)
      if ($grantee -gt 0) {
        if (-not ('OrreryTest.Foreground' -as [type])) { Add-Type -Namespace OrreryTest -Name Foreground -MemberDefinition '[DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);' }
        [Console]::Out.WriteLine('allowfg|' + [OrreryTest.Foreground]::AllowSetForegroundWindow($grantee)); [Console]::Out.Flush()
      }
    }
    elseif ($c -like 'hang *') {
      [Console]::Out.WriteLine('hang|start'); [Console]::Out.Flush()
      [System.Threading.Thread]::Sleep([int]$c.Substring(5))
      [Console]::Out.WriteLine('hang|end'); [Console]::Out.Flush()
    }
  }
  [Console]::Out.WriteLine('tick|' + $f.Handle.ToInt64() + '|' + $f.WindowState + '|' + $f.Refused + '|' + $box.Text)
  [Console]::Out.Flush()
})
$f.add_Shown({ $timer.Start() })
$f.WindowState = $env:ORRERY_TEST_STATE
[System.Windows.Forms.Application]::Run($f)
`;


/**
 * Starts a test window through WMI (Win32_Process.Create), so that its parent is the WMI provider host, not this
 * process. A process started by the foreground process may take the foreground, and with it be brought to the top by
 * another process (SetWindowPos HWND_TOP); when the shell under test runs in this process, a window started from here
 * would have that right whenever the shell is in front, unlike a real app the user started long before. Output comes
 * back through a file, as there is no pipe to a process started this way. Resolves with the WMI process id.
 */
const LAUNCH = [
  "$ErrorActionPreference = 'Stop'",
  '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
  '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:ORRERY_TEST_CMDLINE; ProcessStartupInformation = $si }',
  "[Console]::Out.WriteLine([string]$r.ReturnValue + '|' + [string]$r.ProcessId)",
].join('; ');

function launchUnrelated(vars, out) {
  const prelude = Object.entries({ ...vars, ORRERY_TEST_OUT: out })
    .map(([k, v]) => `$env:${k} = '${String(v).replaceAll("'", "''")}'`).join('\n');
  const redirect = '$w = New-Object System.IO.StreamWriter($env:ORRERY_TEST_OUT, $true); $w.AutoFlush = $true; [Console]::SetOut($w)';
  const encoded = Buffer.from(`${prelude}\n${redirect}\n${SCRIPT}`, 'utf16le').toString('base64');
  return new Promise((done, fail) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LAUNCH], {
      env: { ...process.env, ORRERY_TEST_CMDLINE: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}` },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    p.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
    p.stderr.setEncoding('utf8').on('data', (c) => { stderr += c; });
    p.once('close', () => {
      const [code, pid] = stdout.trim().split('|').map(Number);
      if (code === 0 && pid > 0) done(pid); else fail(new Error(`WMI could not start the test window: ${stdout} ${stderr}`));
    });
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Starts one test window; resolves once it reports its handle. `unrelated`: started through WMI (see above), so it
 * gets no foreground rights from being started by this process (other conditions are Windows' own), as a real app.
 * `strict`: the window models the documented restriction
 * "to bring a window to the top with SetWindowPos, the process that owns it must have SetForegroundWindow
 * permission", in a stronger, explicit form: while it is not the foreground window it refuses any z-order change
 * asked of it without activation (SWP_NOACTIVATE; it adds SWP_NOZORDER in WM_WINDOWPOSCHANGING, where HWND_TOP
 * arrives already resolved to a concrete window) and counts it (`last.refused`). Being activated still brings it up. Windows' real conditions are more varied; without real user input the
 * automated check could not make Windows refuse, so this model stands in for an app that does not follow. Moving
 * another window (the shell) beneath it never asks this window to change.
 */
export async function startTestWindow(dir, { state = 'Normal', unrelated = false, strict = false } = {}) {
  const nonce = randomBytes(4).toString('hex');
  const title = `orrery-desktop-test ${nonce}`;
  const text = `unsaved input ${nonce}`;
  const cmd = join(dir, `cmd-${nonce}.txt`);
  const vars = { ORRERY_TEST_TITLE: title, ORRERY_TEST_TEXT: text, ORRERY_TEST_CMD: cmd, ORRERY_TEST_STATE: state, ORRERY_TEST_STRICT: strict ? '1' : '0' };
  const win = { title, text, pid: 0, hwnd: 0, last: null, lines: [], exited: false, stderr: '' };
  const take = (line) => {
    win.lines.push({ at: Date.now(), line });
    const [kind, hwnd, wstate, refused, ...rest] = line.split('|');
    if (kind === 'tick') { win.hwnd = Number(hwnd); win.last = { at: Date.now(), state: wstate, refused: Number(refused), text: rest.join('|') }; }
  };
  if (unrelated) {
    const out = join(dir, `out-${nonce}.txt`);
    win.pid = await launchUnrelated(vars, out);
    let read = 0;
    let buf = '';
    const poll = setInterval(() => {
      if (!alive(win.pid)) { win.exited = true; clearInterval(poll); }
      let text = '';
      try { text = readFileSync(out, 'utf8'); } catch { return; }
      buf += text.slice(read);
      read = text.length;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const line of parts) take(line.replace(/^﻿/, ''));
    }, 60);
    // Idempotent: once stopped (or seen gone) it never looks the process id up again.
    win.stop = () => {
      if (win.stopped) return;
      win.stopped = true;
      clearInterval(poll);
      if (!win.exited && alive(win.pid)) { try { process.kill(win.pid); } catch { /* already gone */ } }
      win.exited = true;
    };
  } else {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      env: { ...process.env, ...vars }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    win.child = child;
    win.pid = child.pid;
    child.once('exit', () => { win.exited = true; });
    child.stderr.setEncoding('utf8').on('data', (c) => { win.stderr += c; });
    let buf = '';
    child.stdout.setEncoding('utf8').on('data', (c) => {
      buf += c;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const line of parts) take(line);
    });
    win.stop = () => { if (win.stopped) return; win.stopped = true; if (!win.exited) child.kill(); };
  }
  win.command = (c) => { writeFileSync(`${cmd}.tmp`, c); renameSync(`${cmd}.tmp`, cmd); };
  const deadline = Date.now() + 20_000;
  while (!win.hwnd) {
    if (win.exited || Date.now() > deadline) { win.stop(); throw new Error(`test window did not start: ${win.stderr}`); }
    await new Promise((r) => setTimeout(r, 50));
  }
  return win;
}
