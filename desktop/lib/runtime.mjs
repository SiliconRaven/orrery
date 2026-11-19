// Packaged paths are explicit: the Hub is ordinary Node source outside app.asar and its data survives upgrades.
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export function runtimeConfig({ packaged, resourcesPath, userData, node, env = process.env }) {
  if (!packaged) return { node: node || 'node', launcher: join(import.meta.dirname, '..', '..', 'src', 'launcher.ts'), env };
  const home = resolve(env.ORRERY_HOME || join(userData, 'hub'));
  return {
    node: join(resourcesPath, 'node', 'node.exe'),
    launcher: join(resourcesPath, 'hub', 'src', 'launcher.ts'),
    env: { ...env, ORRERY_HOME: home, ORRERY_DB: resolve(env.ORRERY_DB || join(home, 'orrery.db')) },
  };
}

const samePath = (a, b) => typeof a === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
// A direct HTTP socket, so proxy environment variables never receive the local API token.
function localRequest(url, token, method = 'GET') {
  return new Promise((done, fail) => {
    const req = request(url, { method, agent: false, headers: { authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (chunk) => { body += chunk; });
      res.on('end', () => done({ status: res.statusCode, body }));
      res.on('error', fail);
    });
    req.setTimeout(1500, () => req.destroy(new Error('Hub request timed out.')));
    req.on('error', fail);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

/** Installer-only graceful exit. Never sends shutdown before the authenticated instance matches this installation. */
export async function stopInstalledHub(runtime, { timeoutMs = 12000, isAlive = alive } = {}) {
  const home = runtime.env.ORRERY_HOME;
  let discovery;
  try { discovery = JSON.parse(await readFile(join(home, 'hub.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return; throw new Error('Cannot read this installation\'s Hub discovery file.'); }
  let url;
  try { url = new URL(discovery.url); } catch { throw new Error('Invalid Hub discovery URL.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || !Number.isInteger(discovery.pid) || discovery.pid <= 0) {
    throw new Error('Refusing an invalid or non-local Hub discovery entry.');
  }
  const token = runtime.env.ORRERY_API_TOKEN || (await readFile(join(home, 'api-token'), 'utf8')).trim();
  let response;
  try { response = await localRequest(new URL('/api/health', url), token); }
  catch (e) { if (e.code === 'ECONNREFUSED') return; throw new Error('The installed Hub did not answer; it was not stopped.'); }
  if (response.status !== 200) throw new Error('The installed Hub refused authentication; it was not stopped.');
  const health = JSON.parse(response.body);
  if (health.app !== 'orrery' || health.pid !== discovery.pid || !samePath(health.home, home)
    || !samePath(health.db, runtime.env.ORRERY_DB) || !samePath(health.executable, runtime.node)) {
    throw new Error('Hub identity does not match this installation; it was not stopped.');
  }
  if (health.state !== 'stopping') {
    const stopped = await localRequest(new URL('/api/shutdown', url), token, 'POST');
    if (stopped.status !== 202) throw new Error('The installed Hub did not accept shutdown.');
  }
  const deadline = Date.now() + timeoutMs;
  while (isAlive(discovery.pid)) {
    if (Date.now() >= deadline) throw new Error('The installed Hub is still exiting. Close it before continuing installation.');
    await sleep(100);
  }
}
