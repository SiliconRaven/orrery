// A headless Chromium browser (Chrome or Edge, already installed) driven over the DevTools protocol with Node built-ins
// only: child_process to start it, the global WebSocket to talk to it. Used by test/browser-smoke.test.ts.
// Never shows a window, never touches the user's browser profile (a fresh --user-data-dir from tempDir()).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { removeTestDir } from '../scripts/test-temp.ts';
import { tempDir } from './helpers.ts';

/** Overrides the search with one browser program (a Chromium-based browser's executable). */
export const BROWSER_ENV = 'ORRERY_TEST_BROWSER';

/** Standard install locations, read-only: Chrome first, then Edge, then Chromium. */
export function browserCandidates(env: Record<string, string | undefined> = process.env, platform = process.platform): string[] {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
    return [
      ...roots.map((r) => join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...roots.map((r) => join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ];
  }
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/snap/bin/chromium'];
}

/** The browser to use, or why there is none. An override that does not exist counts as none (no fallback search). */
export function findBrowser(env: Record<string, string | undefined> = process.env): { path: string } | { path: null; reason: string } {
  const override = env[BROWSER_ENV];
  if (override) return existsSync(override) ? { path: override } : { path: null, reason: `${BROWSER_ENV} names a file that does not exist` };
  const path = browserCandidates(env).find((p) => existsSync(p));
  return path ? { path } : { path: null, reason: `no Chrome, Edge or Chromium in the standard install locations (set ${BROWSER_ENV} to one)` };
}

type Listener = (method: string, params: any, sessionId?: string) => void;

/** One DevTools protocol connection: commands with ids, events to listeners; every command has a timeout. */
class Cdp {
  private nextId = 1;
  private pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  readonly listeners: Listener[] = [];
  private ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id === undefined) { for (const l of this.listeners) l(msg.method, msg.params, msg.sessionId); return; }
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.fail(new Error(`${msg.error.message} (${msg.error.code})`));
      else p?.ok(msg.result);
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.fail(new Error('DevTools connection closed'));
      this.pending.clear();
    });
  }

  /** Opens the socket within `timeoutMs`; on failure or timeout the socket is closed before the error is thrown. */
  static async connect(url: string, timeoutMs: number, Socket: typeof WebSocket = WebSocket): Promise<Cdp> {
    const ws = new Socket(url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((ok, fail) => {
        timer = setTimeout(() => fail(new Error(`DevTools connect: the browser's WebSocket did not open in ${timeoutMs} ms`)), timeoutMs);
        ws.addEventListener('open', () => ok(), { once: true });
        ws.addEventListener('error', () => fail(new Error('DevTools connect: could not connect to the browser\'s DevTools endpoint')), { once: true });
      });
    } catch (error) {
      try { ws.close(); } catch { /* not open: nothing to close */ }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return new Cdp(ws);
  }

  send(method: string, params: object = {}, sessionId?: string, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(new Error(`DevTools ${method} got no answer in ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); fail(e); } });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close(): void { try { this.ws.close(); } catch { /* already closed */ } }
}

export interface Page {
  navigate(url: string): Promise<void>;
  /** The value of a page expression (JSON-serialisable); throws on an exception in it. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Polls `expression` until it is truthy and returns that value; throws `timed out waiting for <what>`. */
  waitFor<T = unknown>(expression: string, what: string, timeoutMs?: number): Promise<T>;
  /** A real mouse click at the centre of the element `elementExpression` evaluates to (it must not be covered). */
  click(elementExpression: string, what: string): Promise<void>;
  /** Clicks the element to focus it, then inserts `text` as typed input (input events fire). */
  type(elementExpression: string, text: string, what: string): Promise<void>;
  /** A raw DevTools command on this page (for emulation the helpers above do not cover, e.g. a touch screen). */
  send(method: string, params?: object): Promise<any>;
}

export interface Browser {
  page: Page;
  /** Console errors and uncaught exceptions the page reported so far, `redact` values replaced. */
  problems(): { console: string[]; exceptions: string[] };
  /** Closes the browser (gracefully, then the whole process tree) and deletes its profile directory. Never throws. */
  close(): Promise<void>;
}

/** Waits for the line the browser prints with its DevTools address, keeping the last stderr lines for an error. */
function devtoolsUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((ok, fail) => {
    let buffered = '';
    const done = (fn: () => void) => {
      clearTimeout(timer); child.stderr?.off('data', onData); child.off('exit', onExit); child.off('error', onError); fn();
    };
    const onError = (error: Error) => done(() => fail(new Error(`the browser could not be started: ${error.message}`)));
    const onData = (chunk: Buffer) => {
      buffered = (buffered + chunk.toString()).slice(-4000);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buffered);
      if (m) done(() => ok(m[1]));
    };
    const onExit = (code: number | null) => done(() => fail(new Error(`the browser exited (${code}) before it was ready: ${buffered.trim().slice(-600)}`)));
    const timer = setTimeout(() => done(() => fail(new Error(`the browser printed no DevTools address in ${timeoutMs} ms`))), timeoutMs);
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

const exited = (child: ChildProcess, timeoutMs: number) => child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve(true)
  : Promise.race([new Promise<boolean>((ok) => child.once('exit', () => ok(true))), sleep(timeoutMs, false, { ref: false })]);

export interface LaunchOptions {
  /** Values replaced by <redacted> in everything the page reports. */
  redact?: string[];
  /** Deadline for opening the DevTools WebSocket (each later command has its own). */
  connectTimeoutMs?: number;
  /** For tests of start-up failures: the WebSocket constructor, and where the process and profile went. */
  WebSocket?: typeof WebSocket;
  onStart?: (started: { pid: number | undefined; profile: string }) => void;
}

/**
 * Starts `executable` headless with a fresh profile and opens one blank page with console and exception capture. If
 * any start-up step fails or times out, the browser tree is killed and the profile removed before the error is thrown:
 * the caller has no handle to clean up with yet.
 */
export async function launchBrowser(executable: string, options: LaunchOptions = {}): Promise<Browser> {
  const { redact = [], connectTimeoutMs = 30_000 } = options;
  const profile = tempDir();
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-component-extensions-with-background-pages',
    '--disable-background-networking', '--disable-sync', '--disable-default-apps', '--disable-component-update',
    '--disable-breakpad', '--disable-crash-reporter', '--no-service-autorun', '--password-store=basic', '--use-mock-keychain',
    '--disable-features=Translate,MediaRouter,OptimizationHints', '--mute-audio', '--window-size=1280,900', 'about:blank',
  ];
  // shortcut: Chrome's sandbox refuses to run as root (some CI containers); add --no-sandbox only then.
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
  // Its own process group off Windows, so the whole tree can be killed; on Windows taskkill /T walks the tree.
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  child.stderr!.on('data', () => {});   // keep draining after the address line
  child.on('error', () => {});   // a failed spawn: devtoolsUrl reports it (an unhandled 'error' would end the test process)
  const consoleErrors: string[] = [];
  const exceptions: string[] = [];
  const clean = (s: string) => redact.reduce((text, secret) => (secret ? text.split(secret).join('<redacted>') : text), s);
  let cdp: Cdp | null = null;

  const close = async () => {
    try {
      // Without a DevTools connection there is no graceful close to wait for: kill the tree at once.
      if (cdp) { await cdp.send('Browser.close', {}, undefined, 5_000).catch(() => {}); cdp.close(); }
      if (!cdp || !(await exited(child, 5_000))) { killTree(child); await exited(child, 5_000); }
    } catch { /* fall through to the profile removal */ }
    // The browser's helper processes can hold profile files for a moment after the main process exits.
    for (let attempt = 0; attempt < 40; attempt++) {
      try { removeTestDir(dirname(profile), basename(profile)); return; } catch { await sleep(100); }
    }
    // Still held: tempDir()'s exit cleanup tries again, and the next `npm test` sweep after that.
  };

  try {
    options.onStart?.({ pid: child.pid, profile });
    // Every await from here to the return has a deadline, and the catch below cleans up after any of them.
    cdp = await Cdp.connect(await devtoolsUrl(child, 30_000), connectTimeoutMs, options.WebSocket);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.listeners.push((method, params, from) => {
      if (from !== sessionId) return;
      if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails;
        exceptions.push(clean(d.exception?.description ?? d.text ?? 'uncaught exception'));
      } else if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'assert')) {
        consoleErrors.push(clean(params.args.map((a: any) => a.value ?? a.description ?? '').join(' ')));
      } else if (method === 'Log.entryAdded' && params.entry.level === 'error') {
        consoleErrors.push(clean(`${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ''}`));
      }
    });
    const send = (method: string, params: object = {}) => cdp!.send(method, params, sessionId);
    await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Log.enable')]);

    const evaluate = async <T>(expression: string): Promise<T> => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(clean(`page expression failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`));
      return r.result.value as T;
    };
    const waitFor = async <T>(expression: string, what: string, timeoutMs = 20_000): Promise<T> => {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const value = await evaluate<T>(expression);
        if (value) return value;
        if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
        await sleep(50);
      }
    };
    const click = async (elementExpression: string, what: string) => {
      const at = await evaluate<{ x: number; y: number; hit: boolean } | null>(`(() => {
        const el = ${elementExpression};
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, hit: !!hit && (hit === el || el.contains(hit)) };
      })()`);
      if (!at) throw new Error(`${what} is not on the page`);
      if (!at.hit) throw new Error(`${what} is covered by another element`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      }
    };
    const page: Page = {
      async navigate(url) {
        const r = await send('Page.navigate', { url });
        if (r.errorText) throw new Error(`navigation failed: ${r.errorText}`);
        await waitFor(`document.readyState === 'complete'`, 'the page to finish loading');
      },
      evaluate, waitFor, click, send,
      async type(elementExpression, text, what) {
        await click(elementExpression, what);
        await send('Input.insertText', { text });
      },
    };
    return { page, problems: () => ({ console: [...consoleErrors], exceptions: [...exceptions] }), close };
  } catch (error) {
    await close();
    throw error;
  }
}
