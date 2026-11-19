import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { BRIDGE_SECRET_RE, CLAIM_RE, HUB_ID_RE, SIGNATURE_HEADER, signBridgeRequest, type BridgeTarget } from './bridge-protocol.ts';

export interface RegistryRecord extends BridgeTarget {
  version: 1;
  name: string;
  pid: number;
  home: string;
  role: 'active' | 'secondary';
  startedAt: string;
}

const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 4_000;
const BUSY_RENAME = new Set(['EACCES', 'EPERM', 'EBUSY']);
const codeOf = (e: unknown) => (e as NodeJS.ErrnoException).code;

const windowsPrivateScript = `
$ErrorActionPreference = 'Stop'
$path = $env:ORRERY_REGISTRY_ACL_PATH
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($env:ORRERY_REGISTRY_ACL_CREATE -eq '1' -and -not [IO.Directory]::Exists($path)) {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($user)
  foreach ($sid in $trusted) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  }
  [void][IO.Directory]::CreateDirectory($path, $acl)
}
$item = Get-Item -LiteralPath $path -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 1 }
$acl = Get-Acl -LiteralPath $path
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { exit 1 }
foreach ($access in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($access.AccessControlType -eq 'Allow' -and $access.IdentityReference.Value -notin $trusted) { exit 1 }
}
`;

const execFileAsync = promisify(execFile);

/**
 * On Windows chmod does not set a DACL. New registry directories explicitly give access to this user and system admins.
 * Asynchronous: the Hub registers after it listens, and a blocked event loop could not even answer 503 "hub is starting"
 * (a launcher would then take the silent port for another program). Each check is one PowerShell, up to a second.
 */
async function windowsPrivate(path: string, create: boolean): Promise<void> {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  try {
    const run = execFileAsync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsPrivateScript, 'utf16le').toString('base64')],
      { env: { SystemRoot: systemRoot, WINDIR: systemRoot, ORRERY_REGISTRY_ACL_PATH: path, ORRERY_REGISTRY_ACL_CREATE: create ? '1' : '0' },
        timeout: 8_000, windowsHide: true });
    run.child.stdin?.end();   // nothing to read: PowerShell must not wait on an open stdin
    await run;
  } catch {
    throw new Error(`Orrery registry ACL could not be verified as private: ${path}`);
  }
}

async function checkPrivate(path: string, directory: boolean, verifyWindows = true): Promise<void> {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st || (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1) || st.isSymbolicLink()
    || (process.platform !== 'win32' && ((st.mode & 0o077) !== 0 || st.uid !== process.geteuid?.()))) {
    throw new Error(`Orrery registry path is not private: ${path}`);
  }
  if (process.platform === 'win32' && verifyWindows) await windowsPrivate(path, false);
}

async function prepareDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') {
    mkdirSync(dirname(dir), { recursive: true });
    await windowsPrivate(dir, true);
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  await checkPrivate(dir, true, false);
  const hubs = join(dir, 'hubs');
  mkdirSync(hubs, { mode: 0o700, recursive: true });
  await checkPrivate(hubs, true);
}

async function readRegistrySecret(dir: string): Promise<string> {
  const path = join(dir, 'bridge-secret');
  await checkPrivate(path, false);
  const secret = readFileSync(path, 'utf8').trim();
  if (!BRIDGE_SECRET_RE.test(secret)) throw new Error(`Invalid Orrery registry key: ${path}`);
  return secret;
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if (codeOf(e) !== 'ENOENT') throw new Error(`Invalid Orrery registry file: ${path}`); return undefined; }
}

function readText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8').trim(); }
  catch (e) { if (codeOf(e) !== 'ENOENT') throw e; }
}

function isRecord(value: unknown): value is RegistryRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<RegistryRecord>;
  const port = typeof r.url === 'string' ? LOOPBACK_URL.exec(r.url)?.[1] : undefined;
  return r.version === 1 && typeof r.hubId === 'string' && HUB_ID_RE.test(r.hubId)
    && typeof r.claim === 'string' && CLAIM_RE.test(r.claim)
    && !!port && Number(port) <= 65535 && typeof r.pid === 'number' && Number.isSafeInteger(r.pid) && r.pid > 0
    && typeof r.name === 'string' && typeof r.home === 'string' && typeof r.startedAt === 'string'
    && (r.role === 'active' || r.role === 'secondary');
}

function readRecord(path: string): RegistryRecord | undefined {
  const data = readJson(path);
  if (data === undefined || isRecord(data)) return data;
  throw new Error(`Invalid Orrery Hub record: ${path}`);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return codeOf(e) !== 'ESRCH'; }
}

async function replaceFile(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
  try {
    for (const delay of [10, 40, 160, 500]) {
      try { renameSync(tmp, path); return; }
      catch (e) { if (!BUSY_RENAME.has(codeOf(e) ?? '')) throw e; }
      await sleep(delay);
    }
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function takeLock(dir: string): Promise<() => void> {
  const path = join(dir, 'lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  const lock = { pid: process.pid, startedAt: Date.now(), claim: randomUUID() };
  for (;;) {
    try {
      writeFileSync(path, JSON.stringify(lock), { flag: 'wx', mode: 0o600 });
      return () => {
        if ((readJson(path) as typeof lock | undefined)?.claim === lock.claim) rmSync(path, { force: true });
      };
    } catch (e) { if (codeOf(e) !== 'EEXIST') throw e; }
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) continue;
    let owner: Partial<typeof lock> | undefined;
    try { owner = readJson(path) as Partial<typeof lock> | undefined; } catch { /* a new holder may still be writing */ }
    if ((typeof owner?.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0 && !pidAlive(owner.pid))
      || Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      // shortcut: stale-file removal is not atomic with acquisition, replace with an OS lock when that work lands.
      rmSync(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`Orrery registry lock is busy: ${path}`);
    await sleep(30);
  }
}

type ProbeResult = 'matching' | 'refused' | 'unknown';
export function probeRegistryHub(record: RegistryRecord, secret: string): Promise<ProbeResult> {
  const path = '/bridge/whoami';
  return new Promise((done) => {
    const port = Number(LOOPBACK_URL.exec(record.url)?.[1]);
    const req = request({ hostname: '127.0.0.1', port, path, agent: false, headers: {
      host: record.url.slice(7), [SIGNATURE_HEADER]: signBridgeRequest(secret, record, 'GET', path),
    } }, (res) => {
      let data = '';
      res.setEncoding('utf8').on('data', (chunk) => {
        data += chunk;
        if (data.length > 4096) req.destroy();
      });
      res.on('error', () => done('unknown'));
      res.on('end', () => {
        try {
          const who = JSON.parse(data);
          done(res.statusCode === 200 && who.hubId === record.hubId && who.claim === record.claim ? 'matching' : 'unknown');
        } catch { done('unknown'); }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error('Hub did not respond')), 1_000);
    req.on('close', () => { clearTimeout(deadline); done('unknown'); });
    req.on('error', (e) => done(codeOf(e) === 'ECONNREFUSED' ? 'refused' : 'unknown'));
    req.end();
  });
}

export async function registeredHubOnPort(dir: string, port: number): Promise<RegistryRecord | undefined> {
  try {
    const record = readRecord(join(dir, 'active.json'));
    if (record?.url === `http://127.0.0.1:${port}` && record.role === 'active' && pidAlive(record.pid)
      && await probeRegistryHub(record, await readRegistrySecret(dir)) === 'matching') return record;
  } catch { /* the normal port diagnostic remains available */ }
}

export async function registerHub(dir: string, opts: { home: string; name: string; url: string; secondary?: boolean }) {
  await prepareDirectory(dir);
  const activePath = join(dir, 'active.json');
  const release = await takeLock(dir);
  try {
    const keyPath = join(dir, 'bridge-secret');
    const oldKeyPath = join(opts.home, 'secret');
    const previous = readText(oldKeyPath);
    let secret: string;
    if (lstatSync(keyPath, { throwIfNoEntry: false })) secret = await readRegistrySecret(dir);
    else {
      if (previous !== undefined && !BRIDGE_SECRET_RE.test(previous)) throw new Error(`Invalid Orrery bridge key: ${oldKeyPath}`);
      secret = previous ?? randomBytes(32).toString('hex');
      await replaceFile(keyPath, secret + '\n');
    }

    const idPath = join(opts.home, 'hub-id');
    let hubId: string;
    try { hubId = readFileSync(idPath, 'utf8').trim(); }
    catch (e) {
      if (codeOf(e) !== 'ENOENT') throw e;
      hubId = randomUUID();
      writeFileSync(idPath, hubId + '\n', { flag: 'wx', mode: 0o600 });
    }
    if (!HUB_ID_RE.test(hubId)) throw new Error(`Invalid Orrery Hub ID: ${idPath}`);

    const recordPath = join(dir, 'hubs', `${hubId}.json`);
    const sameHome = readRecord(recordPath);
    if (sameHome && pidAlive(sameHome.pid) && await probeRegistryHub(sameHome, secret) !== 'refused') {
      throw new Error('This Orrery home is already registered by another running Hub');
    }
    const active = readRecord(activePath);
    const liveness = active && pidAlive(active.pid) ? await probeRegistryHub(active, secret) : 'refused';
    if (active && liveness === 'unknown') console.warn(`活动 Hub「${active.name}」仍在运行但没有响应`);
    const role = opts.secondary || liveness !== 'refused' ? 'secondary' : 'active';
    const record: RegistryRecord = { version: 1, hubId, name: opts.name, url: opts.url,
      pid: process.pid, home: opts.home, role, claim: randomBytes(16).toString('hex'), startedAt: new Date().toISOString() };

    const keyMigrated = Boolean(previous && previous !== secret);
    if (previous !== secret) {
      await replaceFile(oldKeyPath, secret + '\n');
      if (keyMigrated) console.log('orrery 已统一接入密钥。使用此 Hub 旧密钥的静态 MCP 配置需要更新一次。');
    }
    const body = JSON.stringify(record, null, 2) + '\n';
    await replaceFile(recordPath, body);
    try {
      if (role === 'active') await replaceFile(activePath, body);
      else if (active && liveness === 'refused') rmSync(activePath, { force: true });
    } catch (e) {
      rmSync(recordPath, { force: true });
      throw e;
    }
    return {
      record, secret, keyPath, keyMigrated,
      async close() {
        const unlock = await takeLock(dir);
        try {
          for (const path of [activePath, recordPath]) {
            if (readRecord(path)?.claim === record.claim) rmSync(path, { force: true });
          }
        } finally { unlock(); }
      },
    };
  } finally { release(); }
}
