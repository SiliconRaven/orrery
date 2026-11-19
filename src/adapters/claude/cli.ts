// The Claude Code CLI as the native adapter's short-lived helpers use it (get_usage for the subscription quota): finding
// the CLI without a shell, the environment it gets, and stopping a helper that overran with everything it started.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ClaudeCommand {
  command: string;
  args: string[];   // prefix args, before the CLI flags
}

/**
 * Finds the CLI without a shell. On Windows a `.cmd` shim cannot be spawned without `shell: true`, so an npm
 * install runs its cli.js with this Node instead.
 * shortcut: only knows the native claude.exe and the npm global layout; add more when someone hits another.
 */
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

/**
 * The only variables a CLI helper inherits (case-insensitive). An allowlist, not a denylist: anything else in the
 * Hub's environment (a parent Claude session's variables, CLAUDE_CODE_PLUGIN_DIRS, other secrets) could load code
 * into the helper, so it is not passed on. cliEnv adds the rest.
 */
const CLI_ENV = new Set([
  // Windows basics; OS keeps the CLI's built-in telemetry plugin on its Windows path (without it, it takes a `sh -c` branch)
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'TEMP', 'TMP', 'USERNAME', 'COMPUTERNAME', 'OS',
  // POSIX basics
  'HOME', 'TMPDIR', 'USER', 'LANG', 'TERM',
  // network: proxies and extra CAs
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  // the model (the config dir is set by cliEnv)
  'ANTHROPIC_MODEL',
]);

function cliVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => {
    const key = k.toUpperCase();
    return CLI_ENV.has(key) || key.startsWith('LC_');
  }));
}

/** Claude's default config dir. Setting CLAUDE_CONFIG_DIR, even to this value, changes which global config the CLI reads. */
function defaultClaudeDir(): string {
  return resolve(homedir(), '.claude');
}

/**
 * The environment of every CLI process orrery starts: the allowlist, plus
 * - CLAUDE_CONFIG_DIR when the adapter uses a non-default config dir (unset otherwise, see defaultClaudeDir);
 * - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 (the CLI's documented switch for telemetry, error reporting,
 *   auto-update checks and other nonessential traffic); the native quota's get_usage drops it (see native.ts).
 */
export function cliEnv(env: NodeJS.ProcessEnv, claudeDir: string): NodeJS.ProcessEnv {
  const out = cliVariables(env);
  for (const k of Object.keys(out)) if (k.toUpperCase() === 'CLAUDE_CONFIG_DIR') delete out[k];
  if (claudeDir !== defaultClaudeDir()) out.CLAUDE_CONFIG_DIR = claudeDir;
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return out;
}

// ───────────────────────── bounded helper processes ─────────────────────────

const HELPER_KILL_WAIT_MS = 1_000;
const HELPER_TREE_KILL_WAIT_MS = 5_000;

/** Resolves true once the child has exited, false after `ms`. */
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

/** Only exit code 0 confirms that taskkill stopped the process tree. */
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

/**
 * Stops a helper that overran, with everything it started: the tree is force-killed while the helper itself
 * is still alive, because once it is gone its children can no longer be found from its pid. Windows:
 * taskkill /T /F (5 s wait: enumerating the process table regularly exceeds 1 s, and killing the parent early
 * makes taskkill exit 128 and leave descendants running), reporting unconfirmed cleanup if the helper already
 * exited or taskkill fails/overruns, then stopping any surviving taskkill or helper. POSIX: SIGKILL to its
 * process group (askUsage spawns it detached), falling back to the helper on error.
 */
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
