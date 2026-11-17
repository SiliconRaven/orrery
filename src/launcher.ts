// Desktop launcher (docs/launcher.md): opens the web page, starting the Hub in the background first when it is not
// running. Talks to the Hub only through <home>/hub.json and HTTP. Imports Node built-ins and config.ts only
// (test/boundaries.test.ts). Never ends a process, never opens anything but the verified local Hub address.
// --ensure (the desktop shell, docs/desktop.md): the same probe and start, but no browser and no dialog; the outcome
// is one JSON line on stdout, {"url": ...} or {"error": ...}. Every /api/* call carries the API token (docs/security.md),
// and the page opens with it in the fragment, <url>/#token=<token>, which the browser never sends to the Hub.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { API_TOKEN_RE, REPO_ROOT, resolveConfig, type Config, type Env } from './config.ts';

export const START_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 2_000;
const POLL_MS = 200;
const RETRY_MS = 1_000;
const LAUNCHER = resolve(import.meta.filename);

export interface Health { app: 'orrery'; pid: number; state: string; home: string; db: string }
/** One GET /api/health: nothing listening, no answer in time, or any HTTP answer (body: parsed JSON, else undefined). */
export type HealthResult = { kind: 'refused' } | { kind: 'silent' } | { kind: 'answer'; status: number; body: unknown };
export type Probe =
  | { kind: 'running' | 'stopping'; url: string; pid: number }
  | { kind: 'other-data'; health: Health }
  | { kind: 'unknown'; url: string }   // hub.json names a Hub, but its port gave no definite answer
  | { kind: 'unauthorized'; url: string }   // hub.json names a Hub, and it refuses our API token (401)
  | { kind: 'none' };

export interface SpawnedHub { pid: number | undefined; exited(): boolean }

/** Everything the launcher does to the outside world, so tests never open a browser or a dialog. */
export interface LaunchDeps {
  config: Config;
  health(port: number): Promise<HealthResult>;
  spawnHub(logFile: string): SpawnedHub;
  openBrowser(url: string): Promise<void>;
  showError(message: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const hubUrl = (port: number) => `http://127.0.0.1:${port}`;
const URL_RE = /^http:\/\/127\.0\.0\.1:\d+(\/#token=[A-Za-z0-9._~-]+)?$/;
const URL_PORT_RE = /^http:\/\/127\.0\.0\.1:(\d+)$/;

/** ORRERY_API_TOKEN, else the one the Hub made in <home>/api-token (absent before its first start). */
export function apiTokenOf(config: Config): string | undefined {
  if (config.apiToken) return config.apiToken;
  try {
    const t = readFileSync(join(config.home, 'api-token'), 'utf8').trim();
    return API_TOKEN_RE.test(t) ? t : undefined;
  } catch { return undefined; }
}

/** The page address the browser opens: the token in the fragment, so it never reaches a request line or a log. */
export const pageUrl = (url: string, token: string | undefined) => (token ? `${url}/#token=${token}` : url);

// A new Agent has no proxy from the environment; node:http never follows redirects.
const direct = new Agent();

export function getHealth(port: number, token?: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<HealthResult> {
  return new Promise((done) => {
    const timer = setTimeout(() => { finish({ kind: 'silent' }); req.destroy(); }, timeoutMs);
    const finish = (r: HealthResult) => { clearTimeout(timer); done(r); };
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const req = request({ host: '127.0.0.1', port, path: '/api/health', agent: direct, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { text += c; });
      res.on('end', () => {
        let body: unknown;
        try { body = JSON.parse(text); } catch { /* not JSON: not orrery */ }
        finish({ kind: 'answer', status: res.statusCode ?? 0, body });
      });
      res.on('error', () => finish({ kind: 'silent' }));
    });
    req.on('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ECONNREFUSED' ? { kind: 'refused' } : { kind: 'silent' }));
    req.end();
  });
}

function asHealth(r: HealthResult): Health | null {
  if (r.kind !== 'answer' || r.status !== 200) return null;
  const b = r.body as Record<string, unknown> | undefined;
  return b && b.app === 'orrery' && Number.isInteger(b.pid) && typeof b.state === 'string'
    && typeof b.home === 'string' && typeof b.db === 'string' ? b as unknown as Health : null;
}

const samePath = (a: string, b: string) => process.platform === 'win32'
  ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const sameData = (h: Health, c: Config) => samePath(h.home, c.home) && samePath(h.db, c.dbPath);

/**
 * Is our Hub there? hub.json must name a local address (on any port: a Hub started with another ORRERY_PORT on the
 * same data counts too), and that port's /api/health must answer as orrery with hub.json's pid. "none" only when
 * that is definite: no valid hub.json, nothing listening, an answer that is not orrery, or another pid (a stale
 * file, whose pid is never used for anything). No answer, a non-200 answer or an unknown state is "unknown".
 */
export async function probe(config: Config, health: LaunchDeps['health']): Promise<Probe> {
  const none: Probe = { kind: 'none' };
  let d: { url?: unknown; pid?: unknown } | null;
  try { d = JSON.parse(readFileSync(join(config.home, 'hub.json'), 'utf8')); } catch { return none; }
  if (typeof d?.url !== 'string' || !Number.isInteger(d.pid)) return none;
  const port = Number(URL_PORT_RE.exec(d.url)?.[1]);
  if (!(port >= 1 && port <= 65535) || d.url !== hubUrl(port)) return none;   // 0, out of range, leading zeros
  const url = hubUrl(port);
  const r = await health(port);
  if (r.kind === 'refused') return none;
  if (r.kind === 'answer' && r.status === 401) return { kind: 'unauthorized', url };
  if (r.kind === 'silent' || r.status !== 200) return { kind: 'unknown', url };
  const h = asHealth(r);
  if (!h || h.pid !== d.pid) return none;
  if (!sameData(h, config)) return { kind: 'other-data', health: h };
  return h.state === 'running' || h.state === 'stopping' ? { kind: h.state, url, pid: h.pid } : { kind: 'unknown', url };
}

function fileSize(file: string): number {
  try { return statSync(file).size; } catch { return 0; }
}

/** The last lines the Hub wrote from byte `from` on. */
function logTail(file: string, from: number, lines = 15): string {
  try {
    return readFileSync(file).subarray(from).toString('utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch { return ''; }
}

/** Opens the page (exit code 0), or explains why not (exit code 1). */
export async function launch(deps: LaunchDeps): Promise<number> {
  const { config } = deps;
  const url = hubUrl(config.port);
  const logFile = join(config.home, 'hub.log');
  const fail = async (reason: string) => {
    await deps.showError(`${reason}\n\n日志：${logFile}`);
    return 1;
  };
  const open = async (target: string) => {
    try {
      await deps.openBrowser(pageUrl(target, apiTokenOf(config)));
    } catch {
      return fail(`orrery Hub 已在运行，但打不开默认浏览器。请手动在浏览器里打开 ${target}。`);
    }
    return 0;
  };
  const unauthorized = (u: string) => `${u} 上的 orrery Hub 不接受本机的 API 令牌（${join(config.home, 'api-token')} 或环境变量 ORRERY_API_TOKEN），`
    + '无法确认它用的是这份数据。启动器没有启动新的 Hub，也没有结束它。';
  const otherData = (h: Health) => `已有一个 orrery Hub 在端口 ${config.port} 上运行，但用的是另一个数据目录（${h.home}，数据库 ${h.db}）。`
    + '启动器没有启动新的 Hub，也没有结束它。';
  const portInUse = `端口 ${config.port} 被别的程序占用。启动器没有结束它，也没有换端口或数据库。`
    + '关掉占用这个端口的程序，或用环境变量 ORRERY_PORT 换一个端口后再试。';
  const withTail = (text: string, tail: string) => (tail ? `${text}\n\n日志最后几行：\n${tail}` : text);

  if (config.port === 0) return fail('ORRERY_PORT 为 0（随机端口）时不能用启动器：请设一个固定端口，或不设（默认 4317）。');
  const deadline = deps.now() + START_TIMEOUT_MS;
  const stillStopping = `一个 orrery Hub 正在退出，${START_TIMEOUT_MS / 1000} 秒内没有退完，请稍后再试。启动器没有结束它。`;
  const unconfirmed = (u: string) => `hub.json 指向的 ${u} 没有回答，无法确认上一个 orrery Hub 是否已经退出。启动器没有启动新的 Hub。`
    + `如果确定它已经不在了，删掉 ${join(config.home, 'hub.json')} 后再试。`;
  /**
   * Before every start: reuse a running Hub; wait out a stopping one, or one that cannot be confirmed gone (never
   * start next to it). null = definitely no Hub: start one.
   */
  const settle = async (): Promise<number | null> => {
    for (;;) {
      const p = await probe(config, deps.health);
      if (p.kind === 'other-data') return fail(otherData(p.health));
      if (p.kind === 'unauthorized') return fail(unauthorized(p.url));
      if (p.kind === 'running') return open(p.url);
      if (p.kind === 'none') return null;
      if (deps.now() >= deadline) return fail(p.kind === 'unknown' ? unconfirmed(p.url) : stillStopping);
      await deps.sleep(POLL_MS);
    }
  };
  const settled = await settle();
  if (settled !== null) return settled;

  mkdirSync(config.home, { recursive: true });
  try { renameSync(logFile, `${logFile}.1`); } catch { /* no earlier log */ }
  let from = 0;
  while (deps.now() < deadline) {
    from = fileSize(logFile);
    const child = deps.spawnHub(logFile);
    while (!child.exited() && deps.now() < deadline) {
      const p = await probe(config, deps.health);
      if (p.kind === 'running' && p.pid === child.pid) return open(p.url);
      await deps.sleep(POLL_MS);
    }
    if (!child.exited()) break;
    // It exited early: see who holds the configured port.
    const r = await deps.health(config.port);
    const h = asHealth(r);
    let retry = false;
    if (h) {
      if (!sameData(h, config)) return fail(otherData(h));
      if (h.state === 'running') return open(url);     // e.g. another launcher started it a moment ago
      if (h.state !== 'stopping') return fail(portInUse);
      await deps.sleep(POLL_MS);
      retry = true;
    } else if (r.kind !== 'refused') {
      return fail(portInUse);
    } else {
      const tail = logTail(logFile, from);
      // The port was held when this Hub tried it and is free now: the holder (a Hub that was exiting) just went.
      if (!/EADDRINUSE/.test(tail)) {
        const hint = /ERR_MODULE_NOT_FOUND/.test(tail) ? `\n缺少依赖：先在仓库目录 ${REPO_ROOT} 里运行 npm ci，再试一次。` : '';
        return fail(withTail(`orrery Hub 启动失败。${hint}`, tail));
      }
      await deps.sleep(RETRY_MS);
      retry = true;
    }
    if (retry) {
      const again = await settle();
      if (again !== null) return again;
    }
  }
  return fail(withTail(`orrery Hub 没有在 ${START_TIMEOUT_MS / 1000} 秒内就绪。它可能还在启动：稍后再打开一次，或查看日志。`, logTail(logFile, from)));
}

/**
 * The Hub's environment: inherited, with the paths and port the launcher probes with spelled out absolute, so
 * relative values (resolved against the launcher's working directory) mean the same in the Hub (cwd: REPO_ROOT).
 */
export function childEnv(env: Env, config: Config): Env {
  return { ...env, ORRERY_HOME: config.home, ORRERY_DB: config.dbPath, ORRERY_PORT: String(config.port) };
}

/** Starts `node src/main.ts` detached, without a window, output appended to logFile. */
export function hubSpawner(env: Env, config: Config): LaunchDeps['spawnHub'] {
  const hubEnv = childEnv(env, config);
  return (logFile) => {
    const fd = openSync(logFile, 'a');
    try {
      const child = spawn(process.execPath, [join(REPO_ROOT, 'src', 'main.ts')], {
        cwd: REPO_ROOT, env: hubEnv, detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
      });
      let gone = false;
      child.once('exit', () => { gone = true; });
      child.once('error', () => { gone = true; });
      child.unref();
      return { pid: child.pid, exited: () => gone };
    } finally {
      closeSync(fd);
    }
  };
}

export interface PowerShellResult { code: number | null; stdout: string }
export type PowerShellRunner = (script: string, vars: Record<string, string>) => Promise<PowerShellResult>;

/** Paths and text reach the script only through environment variables, never inside the script text. */
export const runPowerShell: PowerShellRunner = (script, vars) => new Promise((done) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...vars }, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
  child.once('error', () => done({ code: null, stdout }));
  child.once('close', (code) => done({ code, stdout }));
});

export const DIALOG_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
  "[void][System.Windows.Forms.MessageBox]::Show($owner, $env:ORRERY_LAUNCHER_MESSAGE, 'orrery', 'OK', 'Error')",
].join('; ');

export async function showErrorDialog(message: string, run: PowerShellRunner = runPowerShell, platform: string = process.platform): Promise<void> {
  console.error(message);
  if (platform === 'win32') await run(DIALOG_SCRIPT, { ORRERY_LAUNCHER_MESSAGE: message });
}

/** Opens only the local Hub address in the default browser. */
export async function openInBrowser(url: string, run: PowerShellRunner = runPowerShell, platform: string = process.platform): Promise<void> {
  if (!URL_RE.test(url)) throw new Error(`refusing to open ${url}`);
  if (platform === 'win32') {
    const r = await run('Start-Process -FilePath $env:ORRERY_LAUNCHER_URL', { ORRERY_LAUNCHER_URL: url });
    if (r.code !== 0) throw new Error(`could not open the browser (PowerShell exit code ${r.code})`);
    return;
  }
  spawn(platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}

export const SHORTCUT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "$path = Join-Path ([Environment]::GetFolderPath('Desktop')) 'orrery.lnk'",
  '$existed = Test-Path -LiteralPath $path',
  '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($path)',
  '$s.TargetPath = $env:ORRERY_SHORTCUT_TARGET',
  '$s.Arguments = $env:ORRERY_SHORTCUT_ARGUMENTS',
  '$s.WorkingDirectory = $env:ORRERY_SHORTCUT_DIR',
  '$s.IconLocation = $env:ORRERY_SHORTCUT_ICON',
  '$s.WindowStyle = 7',   // minimized
  "$s.Description = 'orrery'",
  '$s.Save()',
  "if ($existed) { 'replaced|' + $path } else { 'created|' + $path }",
].join('; ');

/** npm run shortcut: writes orrery.lnk on the Desktop (Windows only). */
export async function createShortcut(run: PowerShellRunner = runPowerShell, platform: string = process.platform): Promise<number> {
  if (platform !== 'win32') {
    console.log('桌面快捷方式只支持 Windows。其他系统用 npm run open 打开 orrery。');
    return 1;
  }
  const r = await run(SHORTCUT_SCRIPT, {
    ORRERY_SHORTCUT_TARGET: process.execPath,
    ORRERY_SHORTCUT_ARGUMENTS: `"${LAUNCHER}"`,
    ORRERY_SHORTCUT_DIR: REPO_ROOT,
    ORRERY_SHORTCUT_ICON: join(REPO_ROOT, 'desktop', 'assets', 'orrery-icon.ico'),
  });
  const [status, path] = r.stdout.trim().split('|');
  if (r.code !== 0 || !path) {
    console.error('创建桌面快捷方式失败（见上面 PowerShell 的输出）。');
    return 1;
  }
  console.log(status === 'replaced' ? `已覆盖桌面上原有的快捷方式：${path}` : `已在桌面创建快捷方式：${path}`);
  console.log('Node 换了安装位置，或仓库移动以后，要重新运行一次 npm run shortcut。');
  return 0;
}

/**
 * --ensure: where the launcher would open the browser it writes {"url"} instead, and {"error"} where it would show a
 * dialog. Everything else (probe, start, wait, the error texts) is `launch` unchanged.
 */
export function ensureDeps(base: LaunchDeps, write: (line: string) => Promise<void>): LaunchDeps {
  return {
    ...base,
    openBrowser: (url) => write(JSON.stringify({ url })),
    showError: (message) => write(JSON.stringify({ error: message })),
  };
}

/** One line on stdout, flushed before the process exits. */
const printLine = (line: string) => new Promise<void>((done) => { process.stdout.write(`${line}\n`, () => done()); });

export function defaultDeps(config: Config, env: Env): LaunchDeps {
  return {
    config,
    health: (port) => getHealth(port, apiTokenOf(config)),   // read each time: the first Hub start makes the file
    spawnHub: hubSpawner(env, config),
    openBrowser: (url) => openInBrowser(url),
    showError: (message) => showErrorDialog(message),
    sleep: (ms) => sleep(ms),
    now: Date.now,
  };
}

if (import.meta.main) {
  const ensure = process.argv.includes('--ensure');
  let code: number;
  try {
    if (process.argv.includes('--create-shortcut')) code = await createShortcut();
    else {
      const deps = defaultDeps(resolveConfig(process.env), process.env);
      code = await launch(ensure ? ensureDeps(deps, printLine) : deps);
    }
  } catch (e) {
    const message = `orrery 启动器出错：${e instanceof Error ? e.message : String(e)}`;
    if (ensure) await printLine(JSON.stringify({ error: message }));
    else await showErrorDialog(message);
    code = 1;
  }
  process.exit(code);
}
