// What the collaboration page may load, and how the shell reads the launcher's answer (docs/desktop.md "安全边界"
// 6 and 7). Pure functions over URL parsing, never string prefixes; no imports.

/**
 * The output of `node src/launcher.ts --ensure` → the Hub's origin and the page address to load, or the launcher's
 * error text. The address must be loopback HTTP with an explicit port: http://127.0.0.1:<port> or
 * http://localhost:<port>, with nothing else in it but an optional `/#token=<API token>` (docs/security.md).
 * @returns {{ origin: string, page: string } | { error: string }}
 */
export function parseEnsure(stdout, code) {
  const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  let data;
  try { data = JSON.parse(line); } catch { data = null; }
  if (data && typeof data.error === 'string') return { error: data.error };
  if (!data || typeof data.url !== 'string') {
    return { error: `orrery 启动器没有给出 Hub 的地址（退出码 ${code}）。可以在仓库目录里运行 npm run open 看看具体的错误。` };
  }
  let u;
  try { u = new URL(data.url); } catch { return { error: `启动器给出的地址不能用：${data.url}` }; }
  const plain = !u.username && !u.password && u.pathname === '/' && !u.search && (!u.hash || /^#token=[A-Za-z0-9._~-]+$/.test(u.hash));
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || !u.port || !plain) {
    return { error: `启动器给出的地址不是本机的 orrery Hub：${data.url}` };
  }
  return { origin: u.origin, page: `${u.origin}/${u.hash}` };
}

const parse = (url) => { try { return new URL(url); } catch { return null; } };

/**
 * May a frame of the collaboration page go to `url`? The main frame only to the Hub's exact origin (scheme, host
 * and port). A subframe also to about:blank / about:srcdoc, which stay in the page's own origin. Everything else
 * (other sites, claude:, codex:, dsh:, file:, data:, javascript:, …) is stopped and handed to nobody.
 */
export function allowNavigation(hubOrigin, url, isMainFrame) {
  if (!hubOrigin) return false;
  if (!isMainFrame && (url === 'about:blank' || url === 'about:srcdoc')) return true;
  const u = parse(url);
  const hub = parse(hubOrigin);
  // Scheme, host and port compared separately: a blob: URL reports its creator's origin but is not the Hub's page.
  return !!u && !!hub && u.protocol === hub.protocol && u.host === hub.host;
}

/** Is this completed request the web page's "退出 orrery" (POST /api/shutdown answered 202 by the Hub)? */
export function isHubShutdown(hubOrigin, { method, url, statusCode }) {
  if (!hubOrigin || method !== 'POST' || statusCode !== 202) return false;
  try {
    const u = new URL(url);
    return u.origin === hubOrigin && u.pathname === '/api/shutdown';
  } catch {
    return false;
  }
}
