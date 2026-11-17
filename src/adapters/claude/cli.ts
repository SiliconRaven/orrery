// Read-only Claude CLI discovery, environment and bounded helper shutdown for native quota requests.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ClaudeCommand {
  command: string;
  args: string[];   // prefix args, before the CLI flags
}

export function resolveClaudeCommand(env: NodeJS.ProcessEnv = process.env, platform = process.platform): ClaudeCommand {
  if (platform !== 'win32') return { command: 'claude', args: [] };
  for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    const exe = join(dir, 'claude.exe');
    if (existsSync(exe)) return { command: exe, args: [] };
    const cli = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (existsSync(join(dir, 'claude.cmd')) && existsSync(cli)) return { command: process.execPath, args: [cli] };
  }
  throw new Error('claude CLI not found on PATH (looked for claude.exe and an npm claude.cmd)');
}

const CLI_ENV = new Set([
  // Windows basics; OS keeps the CLI's built-in telemetry plugin on its Windows path (without it, it takes a `sh -c` branch)
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'TEMP', 'TMP', 'USERNAME', 'COMPUTERNAME', 'OS',
  // POSIX basics
  'HOME', 'TMPDIR', 'USER', 'LANG', 'TERM',
  // Network proxies and extra CAs used by quota requests.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  // Model choice; the config directory is set by cliEnv.
  'ANTHROPIC_MODEL',
]);

function cliVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => {
    const key = k.toUpperCase();
    return CLI_ENV.has(key) || key.startsWith('LC_');
  }));
}

function defaultClaudeDir(): string {
  return resolve(homedir(), '.claude');
}

export function cliEnv(env: NodeJS.ProcessEnv, claudeDir: string): NodeJS.ProcessEnv {
  const out = cliVariables(env);
  for (const k of Object.keys(out)) if (k.toUpperCase() === 'CLAUDE_CONFIG_DIR') delete out[k];
  if (claudeDir !== defaultClaudeDir()) out.CLAUDE_CONFIG_DIR = claudeDir;
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return out;
}

const HELPER_KILL_WAIT_MS = 1_000;

const HELPER_TREE_KILL_WAIT_MS = 5_000;

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((done) => {
    const onExit = () => {
      clearTimeout(timer);
      done(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      done(false);
    }, ms);
    child.once('exit', onExit);
  });
}

function waitTaskkill(child: ChildProcess, ms: number): Promise<string | null> {
  const outcome = () => child.exitCode === 0 ? null : `taskkill exited with code ${child.exitCode ?? `signal ${child.signalCode}`}; tree cleanup unconfirmed`;
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(outcome());
  return new Promise((done) => {
    const finish = (result: string | null) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      done(result);
    };
    const onExit = () => finish(outcome());
    const onError = () => finish('taskkill could not start; tree cleanup unconfirmed');
    const timer = setTimeout(() => finish(`taskkill did not finish within ${ms} ms; tree cleanup unconfirmed`), ms);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

export interface StopHelperOptions {
  taskkill?: ClaudeCommand;
  treeKillWaitMs?: number;
  killWaitMs?: number;
}

export async function stopHelper(child: ChildProcess, opts: StopHelperOptions = {}): Promise<string | null> {
  const pid = child.pid!;
  const killWaitMs = opts.killWaitMs ?? HELPER_KILL_WAIT_MS;
  let treeError: string | null = null;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) {
      return `helper pid ${pid} already exited; tree cleanup unconfirmed`;
    }
    const tkCmd = opts.taskkill ?? { command: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), args: [] };
    const tk = spawn(tkCmd.command, [...tkCmd.args, '/pid', String(pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true });
    tk.on('error', () => {});
    tk.unref();
    treeError = await waitTaskkill(tk, opts.treeKillWaitMs ?? HELPER_TREE_KILL_WAIT_MS);
    if (treeError && tk.pid !== undefined && tk.exitCode === null && tk.signalCode === null) {
      try { tk.kill(); } catch { /* the failed tree kill is already reported */ }
      if (!(await waitExit(tk, killWaitMs))) treeError += `; taskkill pid ${tk.pid} did not exit after forced stop`;
    }
    if (treeError && child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch { /* waitExit below checks whether the helper remains */ }
    }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
  let parentError: string | null = null;
  if (!(await waitExit(child, killWaitMs))) {
    try { child.kill('SIGKILL'); } catch { /* best-effort fallback */ }
    parentError = (await waitExit(child, killWaitMs))
      ? (process.platform === 'win32' && !treeError ? `pid ${pid} did not exit with taskkill; tree cleanup unconfirmed` : null)
      : `pid ${pid} did not exit after a forced kill`;
  }
  return [treeError, parentError].filter(Boolean).join('; ') || null;
}
