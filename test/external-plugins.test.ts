import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CollaborationActor, CollaborationCommand } from '../src/core/collaboration-types.ts';
import { EXTERNAL_EVENTS, parseExternalManifest, readExternalPlugins, type ExternalInstallation } from '../src/core/external-plugin-config.ts';
import { ExternalEventTranslator } from '../src/core/external-plugin-events.ts';
import { ExternalPluginProcess, externalEnvironment } from '../src/core/external-plugin-process.ts';
import { ExternalPlugins } from '../src/core/external-plugins.ts';
import type { OfficialPlugin } from '../src/core/plugin.ts';
import { REPO_ROOT } from '../src/main.ts';
import { Store } from '../src/core/store.ts';
import type { HubEvent } from '../src/core/types.ts';
import { freePort, rawFetch, startTestHub, tempDir, TEST_TOKEN, waitFor } from './helpers.ts';

const manifest = { id: 'external-test', version: '1.0.0', apiVersion: 1, entry: 'main.mjs', permissions: ['clusters.read', 'messages.read'],
  commands: [{ id: 'test', title: 'Test' }] };
const script = `
import { createInterface } from 'node:readline';
const pending = new Map(); let serial = 0; let initialized; const observed = [];
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
createInterface({input:process.stdin}).on('line', (line) => {
 const m=JSON.parse(line);
 if (!m.method) { const id=pending.get(m.id); pending.delete(m.id); send({id,result:m}); return; }
 if (m.method==='initialize') { initialized=m.params; send({id:m.id,result:{apiVersion:1}}); return; }
 if (m.method==='shutdown') { send({id:m.id,result:{}}); return; }
 if (m.method==='event') { observed.push(m.params); return; }
 const a=m.params.arguments;
 if (a.action==='crash') { process.exit(2); }
 else if (a.action==='hang') { return; }
 else if (a.action==='bad') { process.stdout.write('not JSON\\n'); }
 else if (a.action==='big') { process.stdout.write('x'.repeat(70000)); }
 else if (a.action==='host') { const id='p-'+(++serial); pending.set(id,m.id); send({id,method:a.method,params:a.params}); }
 else if (a.action==='env') { send({id:m.id,result:process.env}); }
 else if (a.action==='events') { send({id:m.id,result:observed}); }
 else if (a.action==='initialize-info') { send({id:m.id,result:initialized}); }
 else if (a.action==='pid') { send({id:m.id,result:process.pid}); }
 else { send({id:m.id,result:a}); }
});
`;

function fixture(extra: Record<string, unknown> = {}): { home: string; directory: string; installation: ExternalInstallation } {
  const directory = tempDir();
  const home = join(directory, 'home'); mkdirSync(home);
  writeFileSync(join(directory, 'orrery-plugin.json'), JSON.stringify({ ...manifest, ...extra }));
  writeFileSync(join(directory, 'main.mjs'), script);
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: [{ manifest: join(directory, 'orrery-plugin.json'),
    permissions: manifest.permissions, clusterIds: ['one'] }] }));
  return { home, directory, installation: readExternalPlugins(home).installations[0] };
}

test('external manifests reject unsupported APIs, capabilities and undeclared hooks', () => {
  assert.equal(parseExternalManifest(manifest).id, 'external-test');
  for (const extra of [{ apiVersion: 2 }, { id: '../bad' }, { version: 'latest' }, { permissions: ['sql'] },
    { entry: '/tmp/plugin.mjs' }, { entry: 'main.ts' }, { commands: [{ id: 'bad/name', title: 'X' }] },
    { commands: [manifest.commands[0], manifest.commands[0]] }, { migrations: ['DROP TABLE messages'] }]) {
    assert.throws(() => parseExternalManifest({ ...manifest, ...extra }));
  }
});

test('external installation is explicit, bounded, scoped, and validates grants and entry containment', () => {
  assert.deepEqual(readExternalPlugins(tempDir()), { installations: [], failures: [] });
  const { home, directory } = fixture();
  const set = (plugins: unknown[]) => writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins }));
  const item = { manifest: join(directory, 'orrery-plugin.json') };
  const loaded = () => readExternalPlugins(home);
  set([item]);
  assert.deepEqual(loaded().installations[0].permissions, []);
  assert.deepEqual(loaded().installations[0].clusterIds, []);
  assert.deepEqual(loaded().installations[0].writeClusterIds, []);
  set([{ ...item, writeClusterIds: ['one'] }]);
  assert.match(loaded().failures[0].error, /write clusters and mention grants need messages.send/);
  set([{ ...item, permissions: ['messages.write'] }]);
  assert.match(loaded().failures[0].error, /unsupported external plugin permission/);
  assert.equal(loaded().installations.length, 0);
  set([{ manifest: 'relative.json' }]); assert.match(loaded().failures[0].error, /absolute/);
  set([item, item]);
  assert.match(loaded().failures[0].error, /duplicate/);
  assert.deepEqual(loaded().installations.map((p) => p.manifest.id), ['external-test'], 'the first copy still loads');
  set([item]);
  writeFileSync(join(directory, 'orrery-plugin.json'), JSON.stringify({ ...manifest, entry: '../outside.mjs' }));
  assert.match(loaded().failures[0].error, /ENOENT|escapes/);
  writeFileSync(join(home, 'external-plugins.json'), '{'); assert.throws(() => readExternalPlugins(home), /cannot read/);
});

test('external configuration and manifest may start with a UTF-8 BOM', () => {
  const { home, directory } = fixture();
  for (const file of [join(home, 'external-plugins.json'), join(directory, 'orrery-plugin.json')]) {
    writeFileSync(file, '﻿' + readFileSync(file, 'utf8'));
  }
  assert.equal(readExternalPlugins(home).installations[0].manifest.id, 'external-test');
});

test('a broken plugin entry is skipped and recorded with its path and the original error', () => {
  const { home, directory } = fixture();
  const good = { manifest: join(directory, 'orrery-plugin.json') };
  const missing = join(directory, 'missing.json');
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: [good, { manifest: missing }] }));
  const { installations, failures } = readExternalPlugins(home);
  assert.deepEqual(installations.map((p) => p.manifest.id), ['external-test'], 'the good plugin still loads');
  assert.equal(failures.length, 1);
  assert.ok(failures[0].error.startsWith(`external plugin #2 (${missing}): `), failures[0].error);
  assert.match(failures[0].error, /ENOENT/);
  assert.equal(failures[0].manifest, null, 'an unreadable manifest has no settings row');
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: [null] }));
  assert.match(readExternalPlugins(home).failures[0].error, /#1 \(no manifest path\): expected a JSON object/);
});

test('external entry symlinks cannot escape the package directory', { skip: process.platform === 'win32' }, () => {
  const { home, directory } = fixture();
  const outside = join(tempDir(), 'outside.mjs'); writeFileSync(outside, '');
  symlinkSync(outside, join(directory, 'linked.mjs'));
  writeFileSync(join(directory, 'orrery-plugin.json'), JSON.stringify({ ...manifest, entry: 'linked.mjs' }));
  assert.match(readExternalPlugins(home).failures[0].error, /escapes/);
});

test('a plugin whose entry is missing is skipped but keeps its manifest for the settings page', () => {
  const { home, directory } = fixture();
  writeFileSync(join(directory, 'orrery-plugin.json'), JSON.stringify({ ...manifest, entry: 'gone.mjs' }));
  const { installations, failures } = readExternalPlugins(home);
  assert.deepEqual(installations, []);
  assert.equal(failures[0].manifest?.id, 'external-test', 'the readable manifest is kept for the failed row');
  assert.match(failures[0].error, /ENOENT/);
});

test('a plugin that requires a skipped plugin is skipped too', () => {
  const { home, directory } = fixture();
  const second = join(tempDir(), 'second'); mkdirSync(second);
  writeFileSync(join(second, 'orrery-plugin.json'), JSON.stringify({ ...manifest, id: 'dependent', requires: ['external-test'] }));
  writeFileSync(join(second, 'main.mjs'), script);
  writeFileSync(join(directory, 'orrery-plugin.json'), JSON.stringify({ ...manifest, entry: 'gone.mjs' }));
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: [
    { manifest: join(directory, 'orrery-plugin.json') },
    { manifest: join(second, 'orrery-plugin.json') },
  ] }));
  const { installations, failures } = readExternalPlugins(home);
  assert.deepEqual(installations, []);
  assert.equal(failures.length, 2);
  assert.match(failures[1].error, /requires external-test, which is not available/);
});

test('one broken external plugin no longer stops the Hub; a readable manifest shows as failed', async () => {
  const { home, directory } = fixture();
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: [
    { manifest: join(directory, 'orrery-plugin.json'), permissions: manifest.permissions, clusterIds: ['one'] },
    { manifest: join(directory, 'gone', 'orrery-plugin.json') },
  ] }));
  let app = await startTestHub({ dir: directory });
  try {
    assert.equal((await app.api('GET', '/api/health')).state, 'running');
    const listing = await app.api('GET', '/api/plugins');
    assert.equal(listing.installed.find((p: any) => p.id === 'external-test').runtime.state, 'ready');
    assert.ok(!listing.installed.some((p: any) => p.unavailable), 'an unreadable manifest has no row');
    await app.close();
    // A readable manifest whose entry is gone: the settings page lists it as failed with START_FAILED.
    writeFileSync(join(directory, 'orrery-plugin.json'), JSON.stringify({ ...manifest, entry: 'gone.mjs' }));
    app = await startTestHub({ dir: directory });
    const failed = (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'external-test');
    assert.equal(failed.runtime.state, 'failed');
    assert.equal(failed.runtime.errorCode, 'START_FAILED');
    assert.equal(failed.unavailable, true);
    assert.ok(!(await app.api('GET', '/api/plugins')).plugins.some((p: any) => p.id === 'external-test'));
  } finally { await app.close(); }
});

test('a plugin whose provider manifest is unreadable is skipped, not left to stop the Hub', () => {
  const { home, directory } = fixture();
  const dependent = join(tempDir(), 'dependent'); mkdirSync(dependent);
  writeFileSync(join(dependent, 'orrery-plugin.json'), JSON.stringify({ ...manifest, id: 'dependent', requires: ['missing-provider'] }));
  writeFileSync(join(dependent, 'main.mjs'), script);
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: [
    { manifest: join(directory, 'removed-provider', 'orrery-plugin.json') },   // whole directory gone: no id known
    { manifest: join(dependent, 'orrery-plugin.json') },
  ] }));
  const { installations, failures } = readExternalPlugins(home);
  assert.deepEqual(installations, []);
  assert.equal(failures.length, 2);
  assert.match(failures[1].error, /requires missing-provider, which is not available/);
});

test('a failed duplicate id does not take a working provider with the same id down', () => {
  const { home, directory } = fixture();
  const dependent = join(tempDir(), 'dependent'); mkdirSync(dependent);
  writeFileSync(join(dependent, 'orrery-plugin.json'), JSON.stringify({ ...manifest, id: 'dependent', requires: ['external-test'] }));
  writeFileSync(join(dependent, 'main.mjs'), script);
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: [
    { manifest: join(directory, 'orrery-plugin.json') },
    { manifest: join(directory, 'orrery-plugin.json') },   // duplicate id: skipped
    { manifest: join(dependent, 'orrery-plugin.json') },
  ] }));
  const { installations, failures } = readExternalPlugins(home);
  assert.deepEqual(installations.map((p) => p.manifest.id), ['external-test', 'dependent']);
  assert.match(failures[0].error, /duplicate/);
});

test('dependencies may be listed after their dependents; registration follows the dependency order', () => {
  const { home, directory } = fixture();
  const provider = join(tempDir(), 'provider'); mkdirSync(provider);
  writeFileSync(join(provider, 'orrery-plugin.json'), JSON.stringify({ ...manifest, id: 'provider' }));
  writeFileSync(join(provider, 'main.mjs'), script);
  const dependent = join(tempDir(), 'dependent'); mkdirSync(dependent);
  writeFileSync(join(dependent, 'orrery-plugin.json'), JSON.stringify({ ...manifest, id: 'dependent', requires: ['provider'] }));
  writeFileSync(join(dependent, 'main.mjs'), script);
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: [
    { manifest: join(dependent, 'orrery-plugin.json') },   // listed first, needs provider
    { manifest: join(provider, 'orrery-plugin.json') },
  ] }));
  const { installations, failures } = readExternalPlugins(home);
  assert.deepEqual(failures, []);
  assert.deepEqual(installations.map((p) => p.manifest.id), ['provider', 'dependent']);
});

test('a skipped plugin named by ORRERY_DISABLED_PLUGINS no longer stops the Hub', async () => {
  const { directory } = fixture();
  writeFileSync(join(directory, 'orrery-plugin.json'), JSON.stringify({ ...manifest, id: 'disabled-broken', entry: 'gone.mjs' }));
  const app = await startTestHub({ dir: directory, disabledPlugins: ['disabled-broken'] });
  try {
    assert.equal((await app.api('GET', '/api/health')).state, 'running');
    const failed = (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'disabled-broken');
    assert.equal(failed.runtime.state, 'failed');
    assert.equal(failed.runtime.errorCode, 'START_FAILED');
  } finally { await app.close(); }
});

test('a skipped external plugin cannot decorate or duplicate a registered official plugin', async () => {
  const { directory } = fixture();
  writeFileSync(join(directory, 'orrery-plugin.json'), JSON.stringify({ ...manifest, id: 'tasks', entry: 'gone.mjs' }));
  const app = await startTestHub({ dir: directory });
  try {
    const listing = await app.api('GET', '/api/plugins');
    const rows = listing.installed.filter((p: any) => p.id === 'tasks');
    assert.equal(rows.length, 1, 'one row for the official plugin');
    assert.equal(rows[0].enabled, true);
    assert.equal(rows[0].origin, undefined, 'not described as a failed external plugin');
    assert.ok(!listing.installed.some((p: any) => p.unavailable), 'the skipped external plugin is log-only');
    assert.ok(listing.plugins.some((p: any) => p.id === 'tasks'), 'the official plugin still runs');
  } finally { await app.close(); }
});

test('a response that cannot be serialized answers an error instead of hanging', async () => {
  let deep: Record<string, unknown> = {};
  for (let i = 0; i < 200_000; i++) deep = { next: deep };   // JSON.stringify overflows the stack on this
  const route: OfficialPlugin = { id: 'deep-response', version: '1.0.0',
    routes: [{ method: 'GET', pattern: /^\/api\/deep-response$/, handle: () => deep }] };
  const app = await startTestHub({ port: await freePort(), plugins: [route] });
  try {
    const answer = await fetch(app.url + '/api/deep-response');
    assert.equal(answer.status, 400, 'the handler answers instead of leaving the response open');
    assert.match((await answer.json()).error, /call stack|serialize/i);
  } finally { await app.close(); }
});

test('external environment does not inherit Hub credentials or Node injection settings', () => {
  assert.deepEqual(externalEnvironment({ PATH: '/bin', SystemRoot: 'C:\\Windows', ORRERY_API_TOKEN: 'secret',
    NODE_OPTIONS: '--require attacker', NODE_PATH: '/private', HOME: '/private', OTHER_TOKEN: 'secret' }), { PATH: '/bin', SystemRoot: 'C:\\Windows' });
});

test('external process initializes, correlates concurrent calls and closes its owned PID', async () => {
  const { installation } = fixture();
  const processPlugin = new ExternalPluginProcess(installation, () => ({}));
  try {
    await processPlugin.start(); assert.equal(processPlugin.state, 'ready');
    const values = await Promise.all([1, 2, 3].map((n) => processPlugin.invoke('test', { n })));
    assert.deepEqual(values, [{ n: 1 }, { n: 2 }, { n: 3 }]);
    await assert.rejects(processPlugin.invoke('unknown', {}), /unknown/);
    const pid = await processPlugin.invoke('test', { action: 'pid' }) as number;
    await processPlugin.close(); await processPlugin.close();
    assert.equal(processPlugin.state, 'stopped');
    assert.throws(() => process.kill(pid, 0));
    await assert.rejects(processPlugin.invoke('test', {}), /stopped/);
  } finally { await processPlugin.close(); }
});

for (const action of ['crash', 'hang', 'bad', 'big']) {
  test(`external ${action} fails closed without crashing its host`, async () => {
    const { installation } = fixture();
    // A busy machine can take seconds to boot the fixture, so the budget stays generous until it is up.
    const processPlugin = new ExternalPluginProcess(installation, () => ({}), 30_000);
    try {
      await processPlugin.start(); assert.equal(processPlugin.state, 'ready', `${processPlugin.errorCode}: ${processPlugin.error}`);
      if (action === 'hang') (processPlugin as unknown as { timeoutMs: number }).timeoutMs = 500;   // only this call waits for the timeout
      await assert.rejects(processPlugin.invoke('test', { action }));
      assert.equal(processPlugin.state, 'failed');
      assert.equal(processPlugin.errorCode, { crash: 'PROCESS_EXITED', hang: 'TIMEOUT', bad: 'PROTOCOL_ERROR', big: 'OUTPUT_LIMIT' }[action]);
      await assert.rejects(processPlugin.invoke('test', {}), /failed/);
    } finally { await processPlugin.close(); }
  });
}

test('external broker limits permissions and clusters, omits private metadata and does not mark reads', async () => {
  const { installation } = fixture();
  const store = new Store(':memory:');
  for (const id of ['one', 'two']) {
    store.insertCluster({ id, name: id, category: '', createdAt: '2026-01-01' }, []);
    store.insertMessage({ id: 'message-' + id, clusterId: id, from: 'user', body: id, mentions: [], replyTo: null,
      chainId: id, hop: 0, createdAt: '2026-01-01' }, []);
  }
  const manager = new ExternalPlugins([installation], store, ['external-test']);
  try {
    await manager.start();
    const host = async (method: string, params: Record<string, unknown> = {}) => await manager.invoke('external-test',
      { command: 'test', arguments: { action: 'host', method, params } }) as { result?: any; error?: unknown };
    assert.deepEqual((await host('host.clusters.list')).result, { clusters: [{ id: 'one', name: 'one' }] });
    const messages = (await host('host.messages.list', { clusterId: 'one' })).result.messages;
    assert.deepEqual(Object.keys(messages[0]), ['id', 'clusterId', 'from', 'body', 'createdAt']);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM reads').get()?.n, 0);
    for (const params of [{ clusterId: 'two' }, { clusterId: 'one', limit: 101 }, { clusterId: 'one', before: 'message-two' }]) {
      assert.ok((await host('host.messages.list', params)).error);
    }
    assert.ok((await host('host.messages.write', {})).error);
    store.db.prepare("UPDATE clusters SET deleted_at = '2026-01-02' WHERE id = 'one'").run();
    assert.deepEqual((await host('host.clusters.list')).result, { clusters: [] });
    assert.ok((await host('host.messages.list', { clusterId: 'one' })).error);
  } finally { await manager.close(); store.close(); }
});

test('external message pages fit one frame: older messages give way and long bodies are cut and marked', async () => {
  const { installation } = fixture();
  const store = new Store(':memory:');
  store.insertCluster({ id: 'one', name: 'one', category: '', createdAt: '2026-01-01' }, []);
  const add = (id: string, body: string) => store.insertMessage({ id, clusterId: 'one', from: 'user', body, mentions: [], replyTo: null,
    chainId: id, hop: 0, createdAt: '2026-01-01' }, []);
  const ids = Array.from({ length: 100 }, (_, i) => `m-${i}`);
  for (const id of ids) add(id, 'x'.repeat(1200));
  const manager = new ExternalPlugins([installation], store, ['external-test']);
  try {
    await manager.start();
    const list = async (params: Record<string, unknown>) => (await manager.invoke('external-test',
      { command: 'test', arguments: { action: 'host', method: 'host.messages.list', params: { clusterId: 'one', ...params } } }) as { result: any }).result;
    const first = await list({ limit: 100 });
    assert.equal(first.truncated, true);
    assert.ok(first.messages.length > 0 && first.messages.length < 100);
    const newest = first.messages.map((m: any) => m.id);
    assert.deepEqual(newest, ids.slice(-newest.length), 'keeps the newest, oldest first');
    const older = await list({ limit: 100, before: newest[0] });
    assert.ok(older.messages.length > 0);
    assert.deepEqual(older.messages.map((m: any) => m.id), ids.slice(100 - newest.length - older.messages.length, 100 - newest.length));
    assert.deepEqual(Object.keys(await list({ limit: 2 })), ['messages'], 'a page that fits is not marked');
    // Plain, cut inside a surrogate pair, and the costliest JSON escape.
    for (const body of ['y'.repeat(70_000), 'a' + '\u{1F642}'.repeat(36_000), '\u0001'.repeat(70_000)]) {
      add(`long-${body.length}-${body.charCodeAt(0)}`, body);
      const [message] = (await list({ limit: 1 })).messages;
      assert.equal(message.bodyTruncated, true);
      assert.equal(message.body.length, 8000);
      assert.ok(message.body.isWellFormed());
    }
  } finally { await manager.close(); store.close(); }
});

test('external missing grants and disabled processes cannot read the host', async () => {
  const { installation } = fixture();
  const store = new Store(':memory:');
  const denied = new ExternalPlugins([{ ...installation, permissions: [] }], store, ['external-test']);
  const disabled = new ExternalPlugins([installation], store, []);
  try {
    await denied.start(); await disabled.start();
    assert.equal(disabled.info('external-test').runtime?.state, 'disabled');
    await assert.rejects(disabled.invoke('external-test', { command: 'test' }), /disabled/);
    const result = await denied.invoke('external-test', { command: 'test', arguments: { action: 'host', method: 'host.clusters.list', params: {} } }) as { error?: unknown };
    assert.ok(result.error);
  } finally { await denied.close(); await disabled.close(); store.close(); }
});

test('external incompatible handshake and missing executable entry fail without rejecting Hub startup', async () => {
  const { directory, installation } = fixture();
  writeFileSync(join(directory, 'main.mjs'), script.replace('result:{apiVersion:1}', 'result:{apiVersion:2}'));
  const incompatible = new ExternalPluginProcess(installation, () => ({}), 500);
  const missing = new ExternalPluginProcess({ ...installation, entry: join(directory, 'missing.mjs') }, () => ({}), 500);
  try {
    await incompatible.start(); await missing.start();
    assert.equal(incompatible.state, 'failed'); assert.equal(missing.state, 'failed');
    await assert.rejects(incompatible.invoke('test', {}), /failed/);
  } finally { await incompatible.close(); await missing.close(); }
});

test('external fragmented UTF-8 responses stay intact and unexpected response IDs fail closed', async () => {
  const { directory, installation } = fixture();
  writeFileSync(join(directory, 'main.mjs'), `
    import { createInterface } from 'node:readline';
    createInterface({input:process.stdin}).on('line', (line) => {
      const m=JSON.parse(line);
      const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:m.params?.arguments?.bad?'unknown':m.id,
        result:m.method==='initialize'?{apiVersion:1}:'中文🙂'})+'\\n');
      process.stdout.write(b.subarray(0,b.length-5));
      setTimeout(()=>process.stdout.write(b.subarray(b.length-5)),5);
    });`);
  const processPlugin = new ExternalPluginProcess(installation, () => ({}));
  try {
    await processPlugin.start();
    assert.equal(await processPlugin.invoke('test', {}), '中文🙂');
    await assert.rejects(processPlugin.invoke('test', { bad: true }));
    assert.equal(processPlugin.state, 'failed');
  } finally { await processPlugin.close(); }
});

test('external first host request can share an output chunk with the initialize response', async () => {
  const { directory, installation } = fixture();
  writeFileSync(join(directory, 'main.mjs'), `
    import {createInterface} from 'node:readline';
    createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line);
      if (m.method==='initialize') process.stdout.write(
        JSON.stringify({jsonrpc:'2.0',id:m.id,result:{apiVersion:1}})+'\\n'+
        JSON.stringify({jsonrpc:'2.0',id:'first-host',method:'host.clusters.list',params:{}})+'\\n');
      else if(m.method==='shutdown') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}})+'\\n');
    });`);
  let calls = 0;
  const plugin = new ExternalPluginProcess(installation, () => { calls++; return {}; });
  try { await plugin.start(); assert.equal(plugin.state, 'ready'); assert.equal(calls, 1); }
  finally { await plugin.close(); }
});

test('external direct exit is detected even when a descendant retains stdout', async () => {
  const { directory, installation } = fixture();
  writeFileSync(join(directory, 'main.mjs'), `
    import {spawn} from 'node:child_process';
    import {createInterface} from 'node:readline';
    createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line);
      if(m.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{apiVersion:1}})+'\\n');
      else if(m.method==='invoke') {
        spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:['ignore',process.stdout,process.stderr]});
        process.exit(0);
      }
    });`);
  const plugin = new ExternalPluginProcess(installation, () => ({}), 30_000);   // a busy machine can take seconds to boot the fixture
  try {
    await plugin.start(); assert.equal(plugin.state, 'ready', `${plugin.errorCode}: ${plugin.error}`);
    (plugin as unknown as { timeoutMs: number }).timeoutMs = 1500;   // the request timeout the exit must beat
    const started = Date.now();
    await assert.rejects(plugin.invoke('test', {}), /process exited/);
    assert.ok(Date.now() - started < 1300, 'detect exit instead of waiting for a request timeout or inherited pipes');
    assert.equal(plugin.state, 'failed');
    // Inspect only the host-owned pipe handles; the production contract does not expose or manage descendants.
    const child = (plugin as unknown as { child: { stdout: { destroyed: boolean }; stderr: { destroyed: boolean } } }).child;
    assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
  } finally { await plugin.close(); }   // the helper ends itself after 2 s; killing it by PID could hit whoever reuses that PID
});

test('external call and input bounds reject excess requests without leaving pending promises', async () => {
  const { installation } = fixture();
  const processPlugin = new ExternalPluginProcess(installation, () => ({}));
  try {
    await processPlugin.start();
    await assert.rejects(processPlugin.invoke('test', { value: 'x'.repeat(70_000) }), /64 KiB/);
    assert.deepEqual(await processPlugin.invoke('test', { valid: true }), { valid: true });
    const pending = Promise.allSettled(Array.from({ length: 16 }, () => processPlugin.invoke('test', { action: 'hang' })));
    await assert.rejects(processPlugin.invoke('test', {}), /too many pending/);
    const closing = processPlugin.close();
    await assert.rejects(processPlugin.invoke('test', {}), /stopping|stopped/);
    await closing;
    assert.ok((await pending).every((result) => result.status === 'rejected'));
  } finally { await processPlugin.close(); }
});

test('external shutdown during initialization settles startup and observes exit before stopped', async () => {
  const { directory, installation } = fixture();
  writeFileSync(join(directory, 'main.mjs'), 'setInterval(() => {}, 1000);');
  const plugin = new ExternalPluginProcess(installation, () => ({}));
  const starting = plugin.start();
  await plugin.close(); await starting;
  assert.equal(plugin.state, 'stopped');
  await plugin.close();
});

test('external shutdown timeout still reaps the direct child and preserves a safe error code', async () => {
  const { directory, installation } = fixture();
  writeFileSync(join(directory, 'main.mjs'), script.replace("if (m.method==='shutdown') { send({id:m.id,result:{}}); return; }", "if (m.method==='shutdown') return;"));
  const plugin = new ExternalPluginProcess(installation, () => ({}));
  try {
    await plugin.start();
    const pid = await plugin.invoke('test', { action: 'pid' }) as number;
    await plugin.close();
    assert.equal(plugin.state, 'stopped'); assert.equal(plugin.errorCode, 'TIMEOUT');
    assert.throws(() => process.kill(pid, 0));
  } finally { await plugin.close(); }
});

test('external configuration cannot shadow an official plugin or grant undeclared permissions', async () => {
  const { directory, home } = fixture();
  writeFileSync(join(directory, 'orrery-plugin.json'), JSON.stringify({ ...manifest, permissions: [] }));
  assert.match(readExternalPlugins(home).failures[0].error, /not requested/);
  writeFileSync(join(directory, 'orrery-plugin.json'), JSON.stringify({ ...manifest, id: 'tasks' }));
  await assert.rejects(startTestHub({ dir: directory }), /registered twice/);
});

test('external crashes do not disable the Hub or other plugins and disabled-by-env cannot be overridden', async () => {
  const { directory } = fixture();
  let app = await startTestHub({ dir: directory });
  try {
    await assert.rejects(app.api('POST', '/api/plugins/external-test/invoke', { command: 'test', arguments: { action: 'crash' } }));
    const listing = await app.api('GET', '/api/plugins');
    assert.equal(listing.installed.find((p: any) => p.id === 'external-test').runtime.state, 'failed');
    assert.ok(listing.plugins.some((p: any) => p.id === 'tasks'));
    assert.ok(!listing.plugins.some((p: any) => p.id === 'external-test'));
    assert.equal((await app.api('GET', '/api/health')).state, 'running');
    await app.close();
    app = await startTestHub({ dir: directory, disabledPlugins: ['external-test'] });
    const disabled = (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'external-test');
    assert.equal(disabled.runtime.state, 'disabled'); assert.equal(disabled.disabledByEnv, true);
    assert.ok(!('entry' in disabled) && !('directory' in disabled));
    await assert.rejects(app.api('PUT', '/api/plugins/external-test', { enabled: true }), /ORRERY_DISABLED_PLUGINS/);
  } finally { await app.close(); }
});

test('standalone sample works outside the checkout through authenticated Hub APIs and existing settings', async () => {
  const dir = tempDir(); const home = join(dir, 'home'); mkdirSync(home);
  const pluginDir = join(tempDir(), 'counter');
  cpSync(resolve('examples/hub-plugins/message-counter'), pluginDir, { recursive: true });
  // Seed only a throwaway database. No native apps or real model calls.
  const store = new Store(join(dir, 'test.db'));
  store.insertCluster({ id: 'one', name: 'Example', category: '', createdAt: '2026-01-01' }, []);
  store.insertMessage({ id: 'm', clusterId: 'one', from: 'user', body: 'hello', mentions: [], replyTo: null,
    chainId: 'm', hop: 0, createdAt: '2026-01-01' }, []);
  store.insertCluster({ id: 'many', name: 'Many', category: '', createdAt: '2026-01-01' }, []);
  for (let i = 0; i < 100; i++) {
    store.insertMessage({ id: `many-${i}`, clusterId: 'many', from: 'user', body: 'x'.repeat(1200), mentions: [], replyTo: null,
      chainId: 'many', hop: 0, createdAt: '2026-01-01' }, []);
  }
  store.close();
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: [{ manifest: join(pluginDir, 'orrery-plugin.json'),
    permissions: ['clusters.read', 'messages.read'], clusterIds: ['one', 'many'] }] }));
  let app = await startTestHub({ dir });
  try {
    const listing = await app.api('GET', '/api/plugins');
    assert.equal(listing.installed.find((p: any) => p.id === 'message-counter').runtime.state, 'ready');
    assert.equal((await rawFetch(app.url + '/api/plugins/message-counter/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    const result = await app.api('POST', '/api/plugins/message-counter/invoke', { command: 'count', arguments: { clusterId: 'one' } });
    assert.deepEqual(result.result, { clusterId: 'one', recentMessageCount: 1, limit: 100, senders: [{ senderId: 'user', count: 1 }] });
    const partial = (await app.api('POST', '/api/plugins/message-counter/invoke', { command: 'count', arguments: { clusterId: 'many' } })).result;
    assert.equal(partial.truncated, true);
    assert.ok(partial.recentMessageCount > 0 && partial.recentMessageCount < 100);
    await assert.rejects(app.api('POST', '/api/plugins/message-counter/invoke', { command: 'count', arguments: { clusterId: 'other' } }));
    await app.api('PUT', '/api/plugins/message-counter', { enabled: false });
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'plugins.json'), 'utf8')).disabled, ['message-counter']);
    await app.api('POST', '/api/plugins/message-counter/stop', {});
    await assert.rejects(app.api('POST', '/api/plugins/message-counter/invoke', { command: 'count' }), /stopped/);
    assert.ok(!(await app.api('GET', '/api/plugins')).plugins.some((p: any) => p.id === 'message-counter'));
    await app.close();
    app = await startTestHub({ dir });
    assert.equal((await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'message-counter').runtime.state, 'disabled');
    assert.equal((await app.api('GET', '/api/health')).state, 'running');
  } finally { await app.close(); }
});

test('standalone review reminder writes once for a pending review in its authorized group', async () => {
  const dir = tempDir();
  const homeDir = join(dir, 'home');
  const pluginDir = join(tempDir(), 'review-reminder');
  mkdirSync(homeDir);
  cpSync(resolve('examples/hub-plugins/review-reminder'), pluginDir, { recursive: true });
  const entry = join(pluginDir, 'main.mjs');
  const original = readFileSync(entry, 'utf8');
  const shorter = original.replace('const REMINDER_DELAY_MS = 5 * 60_000;', 'const REMINDER_DELAY_MS = 250;');
  assert.notEqual(shorter, original, 'only the temporary copy uses a shorter delay');
  writeFileSync(entry, shorter);

  const seed = new Store(join(dir, 'test.db'));
  for (const id of ['one', 'read-only']) {
    seed.insertCluster({ id, name: id, category: '', createdAt: '2026-01-01' }, [{
      id: id + '-executor', clusterId: id, name: 'Executor', avatar: null, harness: 'mock', model: null, effort: null,
      mode: 'native', workerSessionId: id + '-executor', cwd: dir, origin: 'attached', removedAt: null,
    }]);
  }
  seed.close();
  writeFileSync(join(homeDir, 'external-plugins.json'), JSON.stringify({ plugins: [{
    manifest: join(pluginDir, 'orrery-plugin.json'), permissions: ['events.read', 'messages.send'],
    events: ['task.submitted', 'task.approved', 'task.rejected', 'task.merged'],
    clusterIds: ['one', 'read-only'], writeClusterIds: ['one'],
  }] }));

  const app = await startTestHub({ dir, port: await freePort() });
  try {
    const row = (await app.api('GET', '/api/plugins')).installed.find((item: any) => item.id === 'review-reminder');
    assert.equal(row.runtime.state, 'ready');
    const user: CollaborationActor = { kind: 'user' };
    let serial = 0;
    const action = (actor: CollaborationActor, clusterId: string, command: Omit<CollaborationCommand, 'operationId'>) =>
      app.hub.collaboration.command(actor, clusterId, { ...command, operationId: 'reminder-fixture-' + ++serial });
    const submit = (clusterId: string, title: string, reviewer: CollaborationActor = user) => {
      const executor: CollaborationActor = { kind: 'member', memberId: clusterId + '-executor' };
      const created = action(user, clusterId, { action: 'task.create', title, scope: 'Fixture scope', acceptance: 'Fixture acceptance',
        reviewer, memberId: executor.memberId, mergeRequired: false }).task!;
      const started = action(executor, clusterId, { action: 'task.start', taskId: created.id, expectedRevision: created.revision });
      const finish = (expectedRevision: number) => action(executor, clusterId, { action: 'task.submit',
        taskId: created.id, expectedRevision, assignmentId: started.assignment!.id, summary: 'Fixture result' });
      return { finish, ...finish(started.task!.revision) };
    };

    submit('read-only', 'Outside the write grant');
    const approved = submit('one', 'Already reviewed');
    action(user, 'one', { action: 'task.review', taskId: approved.task!.id, expectedRevision: approved.task!.revision,
      submissionId: approved.submission!.id, verdict: 'approve', reason: 'Fixture approval' });
    submit('one', 'Self reviewed', { kind: 'self' });
    const pending = submit('one', 'Still awaiting review');
    pending.finish(pending.task!.revision);

    const reminders = async (clusterId: string) => (await app.messages(clusterId)).filter((msg) => msg.from === 'plugin:review-reminder');
    await waitFor(async () => (await reminders('one')).length, 'the copied plugin to post a reminder');
    // The earlier timers have expired; allow any duplicate reminder already in the pipe to reach the Hub.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const visible = await reminders('one');
    assert.equal(visible.length, 1);
    assert.equal(visible[0].kind, 'plugin');
    assert.match(visible[0].body, /Still awaiting review.*提交后仍未收到验收结果/);
    assert.ok(visible[0].body.includes('#' + pending.task!.id));
    assert.deepEqual(visible[0].mentions, []);
    assert.deepEqual(visible[0].deliveries, []);
    assert.deepEqual(await reminders('read-only'), []);
  } finally { await app.close(); }
});

test('external plugin stuck in initialize: an exit request waits for startup, then the Hub exits 0 and removes hub.json', async () => {
  const { directory, home } = fixture();
  writeFileSync(join(directory, 'main.mjs'), 'setInterval(() => {}, 1000);');
  // The real entry point: the crash was in its top-level code, which startTestHub does not run.
  const child = spawn(process.execPath, ['src/main.ts'], { cwd: REPO_ROOT, stdio: 'ignore',
    env: { ...process.env, ORRERY_PORT: '0', ORRERY_DB: join(directory, 'h.db'), ORRERY_SANDBOX: join(directory, 'sb'), ORRERY_HOME: home, ORRERY_API_TOKEN: TEST_TOKEN } });
  try {
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(20_000) });
    const discovery = join(home, 'hub.json');
    const { url } = await waitFor(() => { try { return JSON.parse(readFileSync(discovery, 'utf8')); } catch { return null; } }, 'hub.json', 15_000);
    const answer = await fetch(url + '/api/shutdown', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(answer.status, 202);
    const [code] = await exited;
    assert.equal(code, 0);
    assert.equal(existsSync(discovery), false);
  } finally { child.kill(); }
});

// ---- event subscription ----

const eventManifest = { permissions: [...manifest.permissions, 'events.read'], events: [...EXTERNAL_EVENTS] };
const eventScript = `
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
const seen = [];
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
const rl = createInterface({input:process.stdin});
rl.on('line', (line) => {
 const m=JSON.parse(line);
 if (m.method==='event') { if ('id' in m) process.exit(9); seen.push(m.params); return; }
 if (m.method==='initialize') {
  send({id:m.id,result:{apiVersion:1}});
  if (globalThis.STUCK_FLAG) { rl.pause(); const t=setInterval(()=>{ if(existsSync(globalThis.STUCK_FLAG)){clearInterval(t);rl.resume();} },5); }
  return;
 }
 if (m.method==='shutdown') { send({id:m.id,result:{}}); return; }
 const a=m.params.arguments;
 if (a.action==='crash') process.exit(2);
 if (a.action==='seen') send({id:m.id,result:seen.slice(-200)});
 else if (a.action==='pid') send({id:m.id,result:process.pid});
 else send({id:m.id,result:{count:seen.length,dropped:seen.reduce((n,e)=>n+(e.dropped??0),0),droppedFrames:seen.filter((e)=>e.dropped).length,last:seen.at(-1)?.data}});
});
`;

/** A plugin that records its events. `stuckFlag`: it stops reading after initialize until this file exists. */
function eventPlugin(overrides: Partial<ExternalInstallation> & { id?: string; stuckFlag?: string } = {}) {
  const { id, stuckFlag, ...fields } = overrides;
  const { directory, installation } = fixture(eventManifest);
  writeFileSync(join(directory, 'main.mjs'), (stuckFlag ? `globalThis.STUCK_FLAG=${JSON.stringify(stuckFlag)};\n` : '') + eventScript);
  return { directory, installation: { ...installation, manifest: { ...installation.manifest, id: id ?? installation.manifest.id },
    permissions: ['events.read'], events: [...EXTERNAL_EVENTS], clusterIds: ['one'], ...fields } as ExternalInstallation };
}
const hubEvent = (kind: HubEvent['kind'], clusterId: string | null, payload: unknown): HubEvent =>
  ({ seq: 1, clusterId, memberId: null, kind, payload, createdAt: '2026-01-02T00:00:00.000Z' });
const messageEvent = (clusterId: string, id = 'm1') => hubEvent('message', clusterId, { message: { id, clusterId, from: 'user', mentions: ['a'],
  body: 'private body', replyTo: null, chainId: 'chain', hop: 2, createdAt: '2026-01-01T00:00:00.000Z' }, deliveries: [{ id: 'd' }], attachments: [{ path: 'C:/private' }] });
const memberEvent = (clusterId: string, status: string, id = 'a', removedAt: string | null = null) => hubEvent('member', clusterId, { member: { id, clusterId, name: 'Alice', status, removedAt,
  workerSessionId: 'native-session', cwd: 'C:/private', harness: 'mock', model: 'private', mcpToken: 'token' } });
const fromPlugin = (manager: ExternalPlugins, action: string, id = 'external-test') => manager.invoke(id, { command: 'test', arguments: { action } }) as Promise<any>;
const internals = (manager: ExternalPlugins, id = 'external-test') =>
  (manager as unknown as { processes: Map<string, { state: string; events: unknown[] }> }).processes.get(id)!;

test('external event grants are declared, need events.read, and an omitted grant means none', () => {
  const requested = { ...manifest, ...eventManifest };
  assert.deepEqual(parseExternalManifest(manifest).events, []);
  assert.equal(parseExternalManifest(requested).events.length, 6);
  assert.throws(() => parseExternalManifest({ ...requested, events: ['delivery.changed'] }), /unsupported/);
  assert.throws(() => parseExternalManifest({ ...manifest, events: ['message.created'] }), /events\.read/);
  const { home, directory } = fixture({ permissions: eventManifest.permissions, events: ['message.created', 'member.status'] });
  const set = (item: object) => writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: [{ manifest: join(directory, 'orrery-plugin.json'), ...item }] }));
  set({ permissions: ['events.read'] }); assert.deepEqual(readExternalPlugins(home).installations[0].events, []);
  set({ permissions: ['events.read'], events: ['member.status'] }); assert.deepEqual(readExternalPlugins(home).installations[0].events, ['member.status']);
  set({ permissions: ['events.read'], events: ['task.merged'] }); assert.match(readExternalPlugins(home).failures[0].error, /not requested/);
  set({ permissions: [], events: ['member.status'] }); assert.match(readExternalPlugins(home).failures[0].error, /events\.read/);
  assert.deepEqual(readExternalPlugins(home).installations, []);
});

test('a plugin with events but no events.read is isolated: the Hub starts, it never runs, the others still get events', async () => {
  const good = eventPlugin();
  const home = join(good.directory, 'home');
  const marker = join(good.directory, 'broken-plugin-ran');
  const broken = [fixture({ id: 'bad-manifest', events: ['message.created'] }), fixture({ id: 'bad-grant', ...eventManifest })];
  for (const plugin of broken) writeFileSync(join(plugin.directory, 'main.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const path = (directory: string) => join(directory, 'orrery-plugin.json');
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: [
    { manifest: path(good.directory), permissions: ['events.read'], events: ['message.created'], clusterIds: ['one'] },
    { manifest: path(broken[0].directory), clusterIds: ['one'] },
    { manifest: path(broken[1].directory), permissions: [], events: ['message.created'], clusterIds: ['one'] },
  ] }));
  const seed = new Store(join(good.directory, 'test.db'));
  seed.insertCluster({ id: 'one', name: 'one', category: '', createdAt: '2026-01-01' }, []);
  seed.close();
  const app = await startTestHub({ dir: good.directory });
  try {
    const installed = (await app.api('GET', '/api/plugins')).installed as any[];
    assert.equal(installed.find((p) => p.id === 'external-test').runtime.state, 'ready');
    const failed = installed.find((p) => p.id === 'bad-grant');
    assert.equal(failed.runtime.errorCode, 'START_FAILED');
    assert.match(failed.runtime.error, /events\.read/);
    assert.ok(!installed.some((p) => p.id === 'bad-manifest'), 'a manifest that does not parse is only in the log');
    assert.equal((await app.api('GET', '/api/health')).state, 'running');
    const sent = app.hub.sendFromUser('one', 'hello');
    await waitFor(async () => ((await app.api('POST', '/api/plugins/external-test/invoke', { command: 'test', arguments: { action: 'seen' } })).result as any[])
      .some((e) => e.data.messageId === sent.id), 'the good plugin to get the event');
    assert.equal(existsSync(marker), false, 'neither broken plugin was started');
  } finally { await app.close(); }
});

test('external events carry exactly the allowlisted fields and never a Hub payload', () => {
  const task = { id: 't1', title: 'Work', status: 'review', scope: 'private scope', acceptance: 'private', assignedMemberId: 'a', mergedCommitSha: 'private' };
  const translator = new ExternalEventTranslator({ tasks: { task: () => task } } as unknown as Store);
  const translate = (event: HubEvent, clusterId: string) => translator.translate(event, clusterId);
  assert.deepEqual(translate(messageEvent('one'), 'one'), [{ type: 'message.created',
    data: { clusterId: 'one', messageId: 'm1', from: 'user', mentions: ['a'], createdAt: '2026-01-01T00:00:00.000Z', kind: null } }]);
  const system = hubEvent('message', 'one', { message: { id: 'm2', clusterId: 'one', from: 'system', mentions: [], body: 'x', createdAt: '2026-01-03', kind: 'system' } });
  assert.equal(translate(system, 'one')[0].data.kind, 'system');
  const taskData = { clusterId: 'one', taskId: 't1', title: 'Work', status: 'review', at: '2026-01-02T00:00:00.000Z' };
  const collab = (payload: object) => translate(hubEvent('collaboration', 'one', { taskId: 't1', reason: 'private', commitSha: 'private', ...payload }), 'one');
  assert.deepEqual(collab({ action: 'task.submit' }), [{ type: 'task.submitted', data: taskData }]);
  assert.deepEqual(collab({ action: 'task.submit', verdict: 'approve' }).map((e) => e.type), ['task.submitted', 'task.approved'], 'a self review is also an approval');
  assert.deepEqual(collab({ action: 'task.review', verdict: 'approve' }), [{ type: 'task.approved', data: taskData }]);
  assert.deepEqual(collab({ action: 'task.review', verdict: 'reject' }), [{ type: 'task.rejected', data: taskData }]);
  for (const action of ['task.merge', 'task.shipped']) assert.deepEqual(collab({ action }), [{ type: 'task.merged', data: taskData }]);
  for (const payload of [{ action: 'task.submit', suggested: true }, { action: 'task.merge', suggested: true }, { action: 'task.claim' }, { action: 'task.approve', approvalVerdict: 'approve' }]) assert.deepEqual(collab(payload), []);
  assert.deepEqual(translate(hubEvent('collaboration', 'one', { action: 'task.submit' }), 'one'), [], 'no task id, no event');
  assert.deepEqual(new ExternalEventTranslator(new Store(':memory:')).translate(hubEvent('collaboration', 'one', { action: 'task.submit', taskId: 't1' }), 'one'), [], 'no tasks plugin, no task events');
  for (const kind of ['cluster', 'delivery', 'read', 'acknowledgement', 'agent', 'guard', 'pause', 'settings', 'usage', 'unread_hint'] as const) {
    assert.deepEqual(translate(hubEvent(kind, 'one', { message: { body: 'x' }, member: { status: 'idle' }, members: [] }), 'one'), [], kind);
  }
  translator.baseline([{ id: 'a', status: 'idle' }]);
  assert.deepEqual(translate(memberEvent('one', 'busy'), 'one'), [{ type: 'member.status',
    data: { clusterId: 'one', memberId: 'a', name: 'Alice', status: 'busy', at: '2026-01-02T00:00:00.000Z' } }]);
});

test('member.status reports only real changes, from a baseline taken at startup or at creation', () => {
  const translator = new ExternalEventTranslator(new Store(':memory:'));
  const member = (status: string, id: string, removedAt: string | null = null) => translator.translate(memberEvent('one', status, id, removedAt), 'one').map((e) => e.data.status);

  translator.baseline([{ id: 'existing', status: 'idle' }, { id: 'renamed', status: 'idle' }]);
  assert.deepEqual(member('idle', 'renamed'), [], 'a rename of a member already idle is no status change');
  assert.deepEqual(member('busy', 'existing'), ['busy'], 'the first real change of a member older than this Hub is sent');
  assert.deepEqual(member('busy', 'existing'), [], 'repeating a status says nothing');
  assert.deepEqual(member('idle', 'existing'), ['idle']);

  assert.deepEqual(member('idle', 'added'), [], 'being added is the baseline, not a change');
  assert.deepEqual(member('idle', 'added'), [], 'nor is its first rename');
  assert.deepEqual(member('busy', 'added'), ['busy']);

  const cluster = (members: object[]) => translator.translate(hubEvent('cluster', 'one', { cluster: { id: 'one' }, members }), 'one');
  assert.deepEqual(cluster([{ id: 'restored', status: 'idle' }]), []);
  assert.deepEqual(member('idle', 'restored'), [], 'a created or restored cluster gives its members a baseline');
  assert.deepEqual(member('busy', 'restored'), ['busy']);

  // Busy when the cluster is deleted, its delivery finishes in the recycle bin, idle at restore: the next busy is real.
  translator.baseline([{ id: 'binned', status: 'idle' }]);
  assert.deepEqual(member('busy', 'binned'), ['busy']);
  assert.deepEqual(cluster([]), [], 'the delete event lists no members');
  assert.deepEqual(cluster([{ id: 'binned', status: 'idle' }]), [], 'the restore event');
  assert.deepEqual(member('busy', 'binned'), ['busy'], 'the status at restore replaces the one from before the delete');

  assert.deepEqual(member('offline', 'existing', '2026-01-03'), ['offline'], 'removal is a real change');
  assert.deepEqual(member('offline', 'existing'), [], 'a removed member is forgotten');
});

test('external events reach only the granted permission, cluster and event type', async () => {
  const store = new Store(':memory:');
  for (const id of ['one', 'two', 'gone']) store.insertCluster({ id, name: id, category: '', createdAt: '2026-01-01' }, []);
  const plugins = [eventPlugin({ id: 'full', clusterIds: ['one', 'gone'] }), eventPlugin({ id: 'status-only', events: ['member.status'] }),
    eventPlugin({ id: 'no-permission', permissions: ['messages.read'] }), eventPlugin({ id: 'no-events', events: [] }),
    eventPlugin({ id: 'other-cluster', clusterIds: ['two'] }), eventPlugin({ id: 'disabled' })];
  const ids = plugins.map((p) => p.installation.manifest.id);
  const manager = new ExternalPlugins(plugins.map((p) => p.installation), store, ids.filter((id) => id !== 'disabled'));
  try {
    await manager.start();
    manager.baselineMembers([{ id: 'a', status: 'offline' }]);
    manager.publish(messageEvent('one')); manager.publish(memberEvent('one', 'idle'));
    store.db.prepare("UPDATE clusters SET deleted_at = '2026-01-02' WHERE id = 'gone'").run();
    manager.publish(messageEvent('gone', 'after-delete'));
    manager.publish(hubEvent('message', null, { message: { id: 'x' } }));
    // A later request travels the same pipe, so it answers only after every earlier event was read.
    const seen = async (id: string) => (await fromPlugin(manager, 'seen', id) as any[]).map((e) => e.type);
    assert.deepEqual(await seen('full'), ['message.created', 'member.status']);
    assert.deepEqual(await seen('status-only'), ['member.status']);
    for (const id of ['no-permission', 'no-events', 'other-cluster']) assert.deepEqual(await seen(id), [], id);
    assert.equal(internals(manager, 'disabled').state, 'disabled');
    assert.equal(internals(manager, 'disabled').events.length, 0);
  } finally { await manager.close(); store.close(); }
});

test('a plugin that stops reading loses only its own oldest events, bounded and counted, and catches up', async () => {
  const flag = join(tempDir(), 'resume');
  const stuck = eventPlugin({ id: 'stuck', stuckFlag: flag });
  const healthy = eventPlugin({ id: 'healthy' });
  const store = new Store(':memory:');
  store.insertCluster({ id: 'one', name: 'one', category: '', createdAt: '2026-01-01' }, []);
  const manager = new ExternalPlugins([stuck.installation, healthy.installation], store, ['stuck', 'healthy']);
  const published = 5000;
  try {
    await manager.start();
    for (let i = 1; i <= published; i++) manager.publish(messageEvent('one', `m-${i}`));
    assert.equal(internals(manager, 'stuck').events.length, 256, 'the queue is capped');
    assert.equal(internals(manager, 'stuck').state, 'ready', 'a slow reader is not a failed plugin');
    const healthySummary = await waitFor(async () => {
      const s = await fromPlugin(manager, 'summary', 'healthy');
      return s.count + s.dropped === published ? s : null;
    }, 'the healthy plugin to catch up');
    assert.equal(healthySummary.last.messageId, `m-${published}`);
    writeFileSync(flag, '');
    const summary = await waitFor(async () => {
      const s = await fromPlugin(manager, 'summary', 'stuck');
      return s.count + s.dropped === published ? s : null;
    }, 'every event delivered or counted', 15_000);
    assert.ok(summary.dropped > 0, 'the flood really overflowed');
    assert.ok(summary.droppedFrames >= 1, 'a later event reports the loss');
    assert.equal(summary.last.messageId, `m-${published}`, 'drops the oldest, keeps the newest');
    assert.ok(summary.count <= 256 + 2048, 'bounded by the queue and the pipe, not by the flood');
    manager.publish(messageEvent('one', 'after'));
    const after = await fromPlugin(manager, 'seen', 'stuck') as any[];
    assert.equal(after.at(-1).data.messageId, 'after');
    assert.equal(after.at(-1).dropped, undefined, 'the count is reported once');
  } finally { await manager.close(); store.close(); }
});

async function eventsQueuedAcrossDeletion(restored: boolean) {
  const flag = join(tempDir(), 'resume');
  const stuck = eventPlugin({ stuckFlag: flag, clusterIds: ['one', 'two'] });
  const store = new Store(':memory:');
  for (const id of ['one', 'two']) store.insertCluster({ id, name: id, category: '', createdAt: '2026-01-01' }, []);
  const manager = new ExternalPlugins([stuck.installation], store, ['external-test']);
  const published = 2000;
  try {
    await manager.start();
    for (let i = 1; i <= published; i++) manager.publish(messageEvent('one', `m-${i}`));
    assert.equal(internals(manager).events.length, 256, 'held back, not yet written');
    store.db.prepare("UPDATE clusters SET deleted_at = '2026-01-02' WHERE id = 'one'").run();
    if (restored) store.db.prepare("UPDATE clusters SET deleted_at = NULL WHERE id = 'one'").run();
    manager.publish(messageEvent('two', 'after'));   // still authorized, and the frame that reports the loss
    writeFileSync(flag, '');
    const summary = await waitFor(async () => {
      const s = await fromPlugin(manager, 'summary');
      return s.last?.messageId === 'after' ? s : null;
    }, 'the event after the deletion', 15_000);
    assert.equal(summary.count + summary.dropped, published + 1, 'every event was delivered or counted');
    const seen = await fromPlugin(manager, 'seen') as any[];
    if (restored) {
      assert.equal(seen.at(-2).data.messageId, `m-${published}`, 'authorized again at the moment of writing, so it is delivered');
      return;
    }
    assert.ok(seen.at(-1).dropped >= 256, 'the deleted cluster\'s queue is counted on the next frame');
    const newest = Math.max(...seen.slice(0, -1).map((e) => Number(e.data.messageId.slice(2))));
    assert.ok(newest <= published - 256, `only frames written before the deletion arrive, newest was m-${newest}`);
  } finally { await manager.close(); store.close(); }
}
test('an event still queued when its cluster is deleted is not delivered and is counted as dropped', () => eventsQueuedAcrossDeletion(false));
test('an event queued across a delete is delivered when the cluster is restored before the write', () => eventsQueuedAcrossDeletion(true));

test('closing a plugin that never reads again ends it within its bound and drops its queue', async () => {
  const stuck = eventPlugin({ stuckFlag: join(tempDir(), 'never') });
  const store = new Store(':memory:');
  store.insertCluster({ id: 'one', name: 'one', category: '', createdAt: '2026-01-01' }, []);
  const manager = new ExternalPlugins([stuck.installation], store, ['external-test']);
  try {
    await manager.start();
    for (let i = 0; i < 2000; i++) manager.publish(messageEvent('one', `m-${i}`));
    const pid = (internals(manager) as unknown as { child: { pid: number } }).child.pid;
    await manager.stop('external-test');
    assert.equal(internals(manager).state, 'stopped');
    assert.equal(internals(manager).events.length, 0);
    assert.throws(() => process.kill(pid, 0));
  } finally { await manager.close(); store.close(); }
});

test('an event too big for one frame or failing its check is dropped and counted instead of failing the plugin', async () => {
  const { installation } = eventPlugin();
  const plugin = new ExternalPluginProcess(installation, () => ({}), undefined, (event) => {
    if (event.data.n === 1) throw new Error('database closed');
    return true;
  });
  const noCheck = new ExternalPluginProcess(installation, () => ({}));
  try {
    await plugin.start(); await noCheck.start();
    plugin.pushEvent({ type: 'message.created', data: { blob: 'x'.repeat(70_000) } });
    plugin.pushEvent({ type: 'message.created', data: { n: 1 } });
    plugin.pushEvent({ type: 'message.created', data: { n: 2 } });
    assert.deepEqual(await plugin.invoke('test', { action: 'seen' }), [{ type: 'message.created', data: { n: 2 }, dropped: 2 }]);
    assert.equal(plugin.state, 'ready');
    noCheck.pushEvent({ type: 'message.created', data: { n: 3 } });
    assert.deepEqual(await noCheck.invoke('test', { action: 'seen' }), [], 'no check supplied means nothing is delivered');
  } finally { await plugin.close(); await noCheck.close(); }
});

test('a stopped or crashed plugin gets no more events and keeps no queue', async () => {
  const store = new Store(':memory:');
  store.insertCluster({ id: 'one', name: 'one', category: '', createdAt: '2026-01-01' }, []);
  const stopped = eventPlugin({ id: 'stopped' });
  const crashed = eventPlugin({ id: 'crashed' });
  const manager = new ExternalPlugins([stopped.installation, crashed.installation], store, ['stopped', 'crashed']);
  try {
    await manager.start();
    manager.publish(messageEvent('one'));
    await manager.stop('stopped');
    await assert.rejects(fromPlugin(manager, 'crash', 'crashed'));
    assert.equal(internals(manager, 'crashed').state, 'failed');
    for (let i = 0; i < 300; i++) manager.publish(messageEvent('one', `late-${i}`));
    for (const id of ['stopped', 'crashed']) assert.equal(internals(manager, id).events.length, 0, id);
    await assert.rejects(fromPlugin(manager, 'seen', 'stopped'), /stopped/);
  } finally { await manager.close(); store.close(); }
});

test('events reach a plugin from the real Hub after commit: messages without bodies, task lifecycle, member status', async () => {
  const { directory, installation } = eventPlugin();
  const home = join(directory, 'home');
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: [{ manifest: join(installation.directory, 'orrery-plugin.json'),
    permissions: ['events.read'], events: EXTERNAL_EVENTS, clusterIds: ['one'] }] }));
  // A real merge whose second parent is the reviewed commit: task.merge may check it with read-only git.
  const repo = tempDir();
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q', '-b', 'main'); git('commit', '-q', '--allow-empty', '-m', 'base');
  git('checkout', '-q', '-b', 'work'); git('commit', '-q', '--allow-empty', '-m', 'reviewed');
  const reviewed = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main'); git('merge', '-q', '--no-ff', 'work', '-m', 'merge');
  const mergeCommit = git('rev-parse', 'HEAD');
  const seed = new Store(join(directory, 'test.db'));
  for (const id of ['one', 'two']) {
    seed.insertCluster({ id, name: id, category: '', createdAt: '2026-01-01' }, ['a', 'b', 'c'].map((name) => ({ id: `${id}-${name}`, clusterId: id, name, avatar: null, harness: 'mock', model: null, effort: null,
      mode: 'native' as const, workerSessionId: `session-${id}-${name}`, cwd: repo, origin: 'attached' as const, removedAt: null })));
  }
  seed.close();
  const app = await startTestHub({ dir: directory });
  // Only the delivery this test watches stays open; task notices finish at once so nothing is queued behind it.
  const held = Promise.withResolvers<'completed'>();
  let holding = false;
  app.native.deliver = async (_session, text) => { if (!text.includes('please')) return 'completed'; holding = true; return held.promise; };
  try {
    const listing = (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'external-test');
    assert.equal(listing.runtime.state, 'ready');
    assert.deepEqual(listing.events, [...EXTERNAL_EVENTS]);
    const seen = async () => (await app.api('POST', '/api/plugins/external-test/invoke', { command: 'test', arguments: { action: 'seen' } })).result as any[];
    const sent = app.hub.sendFromUser('one', 'top secret body');
    app.hub.sendFromUser('two', 'other cluster body');

    const user: CollaborationActor = { kind: 'user' };
    const as = (memberId: string): CollaborationActor => ({ kind: 'member', memberId });
    let serial = 0;
    const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) => app.hub.collaboration.command(actor, 'one', { ...command, operationId: `op-${++serial}` });
    const revision = (taskId: string) => (app.hub.collaboration.query(user, 'one', { kind: 'task', taskId }) as { task: { revision: number } }).task.revision;
    const act = (actor: CollaborationActor, taskId: string, command: Omit<CollaborationCommand, 'operationId' | 'taskId' | 'expectedRevision'>) =>
      send(actor, { ...command, taskId, expectedRevision: revision(taskId) });
    const start = (taskId: string) => {
      const claim = act(as('one-a'), taskId, { action: 'task.claim' });
      act(as('one-a'), taskId, { action: 'task.start', assignmentId: claim.assignment!.id });
      return claim.assignment!.id;
    };
    const submit = (taskId: string, assignmentId: string) => act(as('one-a'), taskId, { action: 'task.submit', assignmentId, summary: 'done', evidenceMessageIds: [sent.id], commitSha: reviewed });

    app.hub.updateMember('one-c', { name: 'renamed' });
    const task = send(user, { action: 'task.create', title: 'Reviewed work', scope: 'private scope', acceptance: 'private acceptance', reviewer: as('one-b') }).task!;
    const assignmentId = start(task.id);
    const first = submit(task.id, assignmentId);
    act(as('one-b'), task.id, { action: 'task.review', submissionId: first.submission!.id, verdict: 'reject', reason: 'private reason' });
    const second = submit(task.id, assignmentId);
    act(as('one-b'), task.id, { action: 'task.review', submissionId: second.submission!.id, verdict: 'approve', reason: 'private reason' });
    act(user, task.id, { action: 'task.merge', commitSha: mergeCommit });
    const selfTask = send(user, { action: 'task.create', title: 'Self work', scope: 's', acceptance: 'a', reviewer: { kind: 'self' } }).task!;
    submit(selfTask.id, start(selfTask.id));

    app.hub.sendFromUser('one', '@a please');
    await waitFor(() => holding, 'the delivery to start');
    const busy = await waitFor(async () => (await seen()).find((e) => e.type === 'member.status' && e.data.memberId === 'one-a' && e.data.status === 'busy'), 'member.status busy');
    assert.deepEqual(Object.keys(busy.data), ['clusterId', 'memberId', 'name', 'status', 'at']);
    assert.equal(busy.data.name, 'a');

    const events = await seen();
    const created = events.find((e) => e.type === 'message.created' && e.data.messageId === sent.id)!;
    assert.deepEqual(Object.keys(created.data), ['clusterId', 'messageId', 'from', 'mentions', 'createdAt', 'kind']);
    assert.equal(created.data.from, 'user');
    const text = JSON.stringify(events);
    for (const secret of ['top secret body', 'other cluster body', 'private scope', 'private acceptance', 'private reason', mergeCommit, reviewed, repo.replaceAll('\\', '\\\\')]) assert.ok(!text.includes(secret), secret);
    assert.ok(events.every((e) => e.data.clusterId === 'one'), 'the second cluster stays out');
    const lifecycle = events.filter((e) => e.type.startsWith('task.')).map((e) => [e.type, e.data.title, e.data.status]);
    assert.deepEqual(lifecycle, [
      ['task.submitted', 'Reviewed work', 'review'], ['task.rejected', 'Reviewed work', 'working'],
      ['task.submitted', 'Reviewed work', 'review'], ['task.approved', 'Reviewed work', 'completed'],
      ['task.merged', 'Reviewed work', 'merged'], ['task.submitted', 'Self work', 'completed'], ['task.approved', 'Self work', 'completed'],
    ]);
    held.resolve('completed');
    await waitFor(async () => (await seen()).some((e) => e.type === 'member.status' && e.data.memberId === 'one-a' && e.data.status === 'idle'), 'member.status idle');
    const statuses = (await seen()).filter((e) => e.type === 'member.status');
    assert.equal(statuses.find((e) => e.data.memberId === 'one-a').data.status, 'busy', 'a member older than this Hub: its first event is its first real change');
    assert.ok(!statuses.some((e) => e.data.memberId === 'one-c'), 'a rename while idle is no status change');
  } finally { held.resolve('completed'); await app.close(); }
});


function writeFixture() {
  const dir = tempDir();
  const homeDir = join(dir, 'home');
  mkdirSync(homeDir);
  const clusterIds = ['one', 'two', 'read-only', 'gone'];
  const seed = new Store(join(dir, 'test.db'));
  for (const clusterId of clusterIds) {
    seed.insertCluster({ id: clusterId, name: clusterId, category: '', createdAt: '2026-01-01' },
      ['Alice', 'Bob'].map((name) => ({ id: clusterId + '-' + name, clusterId, name, avatar: null,
        harness: 'mock', model: null, effort: null, mode: 'native' as const, workerSessionId: clusterId + '-' + name,
        cwd: dir, origin: 'attached' as const, removedAt: null })));
  }
  seed.deleteCluster('gone');
  seed.close();

  const grant = (id: string, extras: string[], clusterIds: string[], writeClusterIds: string[]) => {
    const permissions = [...manifest.permissions, 'events.read', ...extras];
    const events = ['message.created'];
    const { directory } = fixture({ id, permissions, events });
    return { manifest: join(directory, 'orrery-plugin.json'), permissions, events, clusterIds, writeClusterIds };
  };
  const installations = [
    grant('writer', ['messages.send', 'messages.mention'], ['one', 'read-only'], ['one', 'two', 'gone']),
    grant('observer', ['messages.send'], ['one'], ['one']),
    grant('reader', [], ['one'], []),
  ];
  writeFileSync(join(homeDir, 'external-plugins.json'), JSON.stringify({ plugins: installations }));
  return dir;
}

type WriteApp = Awaited<ReturnType<typeof startTestHub>>;
const pluginCommand = async (app: WriteApp, id: string, args: object) =>
  (await app.api('POST', '/api/plugins/' + id + '/invoke', { command: 'test', arguments: args })).result;
const pluginCall = (app: WriteApp, id: string, method: string, params: object) =>
  pluginCommand(app, id, { action: 'host', method, params });
const pluginSend = (app: WriteApp, id: string, params: object) => pluginCall(app, id, 'host.messages.send', params);
const writeSettingsPath = (id: string) => '/api/plugins/' + id + '/write-settings';
const denied = (response: any) => {
  assert.equal(response.error?.code, -32000);
  assert.equal(response.result, undefined);
};

test('external plugin write grants are independent, reject impersonation, and obey mentions, pause and chain limits', async (t) => {
  const app = await startTestHub({ dir: writeFixture(), limits: { maxHops: 1, maxTurnsPerChain: 1, maxTurnsPerHour: 1 } });
  const snapshot = async () => (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'writer');
  const send = (params: object) => pluginSend(app, 'writer', params);
  const message = (id: string) => app.store.getMessage(id)!;
  try {
    assert.deepEqual((await snapshot()).writeSettings, { mentionEnabled: false, perMinute: 10, perHour: 200 });
    const initialized = await pluginCommand(app, 'writer', { action: 'initialize-info' });
    assert.deepEqual(initialized.clusterIds, ['one', 'read-only']);
    assert.deepEqual(initialized.writeClusterIds, ['one', 'two', 'gone']);
    const unauthorized = await rawFetch(app.url + writeSettingsPath('writer'), { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: '{"mentionEnabled":true}' });
    assert.equal(unauthorized.status, 401);
    await assert.rejects(app.api('PATCH', writeSettingsPath('observer'), { mentionEnabled: true }), /messages\.mention/);
    const root = app.hub.sendFromUser('one', 'causal root');
    const other = app.hub.sendFromUser('read-only', 'another cluster');
    denied(await pluginSend(app, 'reader', { clusterId: 'one', body: 'read only' }));
    for (const params of [
      { clusterId: 'read-only', body: 'read permission is not write permission' },
      { clusterId: 'gone', body: 'a deleted write grant is inactive' },
      { clusterId: 'one', body: 'pretend', from: 'user' },
      { clusterId: 'one', body: 'attach', attachments: ['fake'] },
      { clusterId: 'one', body: 'explicit target', to: ['Bob'] },
      { clusterId: 'one', body: 'cross cluster cause', causedBy: other.id },
      { clusterId: 'one', body: 'unknown cause', causedBy: 'not-a-message' },
      { clusterId: 'one', body: 'x'.repeat(8001) },
    ]) denied(await send(params));
    assert.equal(app.store.listMessages('one', 100).filter((msg) => msg.kind === 'plugin').length, 0);
    assert.ok((await send({ clusterId: 'two', body: 'write only' })).result, 'the read allowlist does not constrain write');
    denied(await pluginCall(app, 'writer', 'host.messages.list', { clusterId: 'two' }));
    denied(await pluginCall(app, 'writer', 'host.messages.delete', { clusterId: 'one' }));

    const plain = (await send({ clusterId: 'one', body: '@Alice @all literal' })).result;
    assert.deepEqual(plain.deliveredTo, []);
    assert.deepEqual(message(plain.messageId).mentions, []);
    assert.equal(message(plain.messageId).from, 'plugin:writer');
    assert.equal(message(plain.messageId).kind, 'plugin');
    assert.equal(message(plain.messageId).chainId, plain.messageId);
    assert.equal(message(plain.messageId).hop, 0);

    await app.api('PATCH', writeSettingsPath('writer'), { mentionEnabled: true, perMinute: null, perHour: null, confirmUnlimited: true });
    const broadcast = (await send({ clusterId: 'one', body: '@all for your information' })).result;
    assert.deepEqual(broadcast.deliveredTo, []);
    assert.deepEqual(message(broadcast.messageId).mentions, ['one-Alice', 'one-Bob']);
    assert.ok(app.store.listUnread('one-Bob', 'one', 100).some((msg) => msg.id === broadcast.messageId));

    app.hub.setPaused(true);
    const mixed = (await send({ clusterId: 'one', body: '@all @Alice please look. `@Bob`', causedBy: root.id })).result;
    const deliveryOf = async (id: string) => (await app.messages('one')).find((msg) => msg.id === id)!.deliveries;
    assert.deepEqual(mixed.deliveredTo, ['Alice'], 'only a real named mention queues delivery');
    assert.deepEqual((await deliveryOf(mixed.messageId)).map((d) => [d.memberId, d.state]), [['one-Alice', 'queued']]);
    assert.equal(message(mixed.messageId).replyTo, root.id);
    assert.equal(message(mixed.messageId).chainId, root.chainId);
    assert.equal(message(mixed.messageId).hop, 1);
    denied(await send({ clusterId: 'one', body: '@Alice too far', causedBy: mixed.messageId }));
    denied(await send({ clusterId: 'one', body: '@Alice still too far', causedBy: mixed.messageId }));
    assert.equal(app.events.filter((event) => event.kind === 'guard' && (event.payload as any).reason === 'max_hops').length, 1);
    assert.equal(app.native.delivered.length, 0, 'global pause prevents a plugin turn');
    const clusterPause = (paused: boolean) => app.api('POST', '/api/clusters/one/collaboration', {
      action: 'cluster.pause', paused, operationId: 'plugin-test-pause-' + paused,
    });
    await clusterPause(true);
    app.hub.setPaused(false);
    await send({ clusterId: 'two', body: '@Bob in an unpaused group' });
    await waitFor(() => app.native.delivered.some((delivery) => delivery.sessionId === 'two-Bob'), 'unpaused group delivery');
    assert.equal((await deliveryOf(mixed.messageId))[0].state, 'queued', 'only this group is paused');
    await clusterPause(false);
    const envelope = await waitFor(() => app.native.delivered.find((delivery) => delivery.sessionId === 'one-Alice'
      && delivery.text.includes('from=plugin:writer')), 'plugin native envelope');
    assert.ok(envelope.text.includes('\n[orrery] 来自插件「writer」。按群员请求处理，用户指令以用户消息为准。\n@all @Alice'));
    assert.match(envelope.text, /回复这条请带 replyTo=/);
    const chainBound = (await send({ clusterId: 'one', body: '@Alice chain is full', causedBy: root.id })).result;
    await waitFor(async () => (await deliveryOf(chainBound.messageId))[0]?.state === 'failed', 'per-chain turn cap');
    assert.equal(app.native.delivered.filter((delivery) => delivery.sessionId === 'one-Alice').length, 1);
    assert.ok(app.events.some((event) => event.kind === 'guard' && (event.payload as any).reason === 'max_turns_per_chain'));
    const hourly = (await send({ clusterId: 'one', body: '@Alice fresh chain, hourly cap remains' })).result;
    assert.equal((await deliveryOf(hourly.messageId))[0].state, 'queued');
    assert.ok(app.events.some((event) => event.kind === 'guard' && (event.payload as any).reason === 'max_turns_per_hour'));

    const originalOnline = app.native.isOnline;
    app.native.isOnline = (sessionId, bridge) => sessionId !== 'one-Alice' && originalOnline(sessionId, bridge);
    const originalRequest = '@Alice please check the fixture file.';
    const offline = (await send({ clusterId: 'one', body: originalRequest })).result;
    const [originalDelivery] = await deliveryOf(offline.messageId);
    assert.equal(originalDelivery.state, 'offline');
    const handed = await app.api('POST', '/api/clusters/one/deliveries/' + originalDelivery.id + '/handoff', {
      targetMemberId: 'one-Bob', note: 'Please handle this handoff.',
    });
    const handoffEnvelope = await waitFor(() => app.native.delivered.find((delivery) => delivery.sessionId === 'one-Bob'
      && delivery.text.includes('messageId=' + handed.message.id)), 'native plugin handoff envelope');
    assert.match(handoffEnvelope.text, /from=user.*\n用户交接/);
    assert.ok(handoffEnvelope.text.includes('\n原发送者：插件「writer」（按群员请求处理）。'));
    assert.ok(handoffEnvelope.text.includes('\n\n原请求：\n' + originalRequest + '\n\n用户补充：\nPlease handle this handoff.'));

    // A subscriber fault happens after the DB commit. The child still gets the id, and other subscribers see it.
    t.mock.method(console, 'warn', () => {});
    const stopFault = app.hub.subscribe((event) => {
      if (event.kind === 'message' && (event.payload as any).message?.body === 'subscriber fixture') throw new Error('observer fixture');
    });
    const observed: string[] = [];
    const stopObserver = app.hub.subscribe((event) => {
      if (event.kind === 'message') observed.push((event.payload as any).message.id);
    });
    try {
      const committed = (await send({ clusterId: 'one', body: 'subscriber fixture' })).result;
      assert.equal(message(committed.messageId).body, 'subscriber fixture');
      assert.ok(observed.includes(committed.messageId));
    } finally { stopFault(); stopObserver(); }
    assert.equal((await snapshot()).runtime.state, 'ready', 'denied requests do not stop the plugin');
  } finally { await app.close(); }
});

test('external plugin rates are per plugin and group, can be confirmed unlimited, persist, and never echo to the source', async (t) => {
  const dir = writeFixture();
  let app = await startTestHub({ dir });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const patch = (body: object) => app.api('PATCH', writeSettingsPath('writer'), body);
    await assert.rejects(patch({ perMinute: 0 }), /正整数/);
    await assert.rejects(patch({ perMinute: null }), /confirmUnlimited/);
    await patch({ perMinute: 2, perHour: 3 });
    const send = (body: string, clusterId = 'one') => pluginSend(app, 'writer', { clusterId, body });
    const one = (await send('first')).result.messageId;
    assert.ok((await send('second')).result);
    denied(await send('minute blocked'));
    denied(await send('still blocked'));
    assert.ok((await send('separate group', 'two')).result);
    assert.ok((await pluginSend(app, 'observer', { clusterId: 'one', body: 'separate plugin' })).result);
    await patch({ perMinute: null, confirmUnlimited: true });
    assert.ok((await send('third')).result);
    denied(await send('hour blocked'));
    t.mock.timers.tick(60_000);
    denied(await send('hour still blocked'));
    // A settings change clears the rate cache, but does not make it time for another hourly warning.
    await patch({ perHour: 3 });
    denied(await send('hour checked again'));
    assert.equal(app.store.listMessages('one', 100).filter((msg) => msg.from === 'plugin:writer').length, 3);
    const guards = app.events.filter((e) => e.kind === 'guard' && (e.payload as any).reason === 'external_plugin_rate_limit');
    assert.deepEqual(guards.map((guard) => (guard.payload as any).window), ['minute', 'hour']);
    const warnings = app.store.listMessages('one', 100).filter((msg) => msg.body.includes('达到发送上限'));
    assert.equal(warnings.length, 2);
    for (const warning of warnings) {
      assert.equal(warning.from, 'system');
      assert.equal(warning.systemKind, 'plugin_rate_limit');
      assert.deepEqual(warning.mentions, []);
      assert.equal(app.store.withDeliveries([warning])[0].deliveries.length, 0);
    }
    const writerEvents = await pluginCommand(app, 'writer', { action: 'events' });
    assert.ok(!writerEvents.some((event: any) => event.data.from === 'plugin:writer' || warnings.some((warning) => event.data.messageId === warning.id)));
    const otherEvents = await pluginCommand(app, 'observer', { action: 'events' });
    assert.ok(otherEvents.some((event: any) => event.data.messageId === one && event.data.kind === 'plugin' && event.data.from === 'plugin:writer'));
    await patch({ mentionEnabled: true });
    await app.close();

    app = await startTestHub({ dir });
    const row = (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'writer');
    assert.deepEqual(row.writeSettings, { mentionEnabled: true, perMinute: null, perHour: 3 });
    denied(await pluginSend(app, 'writer', { clusterId: 'one', body: 'the hourly count survived restart' }));
    await app.api('PATCH', writeSettingsPath('writer'), { perHour: null, confirmUnlimited: true });
    assert.ok((await pluginSend(app, 'writer', { clusterId: 'one', body: 'both limits unlimited' })).result);
  } finally { await app.close(); }
});

test('external plugin rate rejections skip repeated SQLite lookups until the exact release time or a settings change', async (t) => {
  const app = await startTestHub({ dir: writeFixture() });
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const lookup = t.mock.method(app.store, 'pluginRateBoundary');
    const patch = (body: object) => app.api('PATCH', writeSettingsPath('writer'), body);
    const send = (body: string) => pluginSend(app, 'writer', { clusterId: 'one', body });
    await patch({ perMinute: 1, perHour: null, confirmUnlimited: true });
    assert.ok((await send('uses the minute')).result);
    denied(await send('establishes the exhausted window'));
    const before = lookup.mock.callCount();
    for (let n = 0; n < 8; n++) denied(await send('cached rejection'));
    t.mock.timers.tick(59_999);
    denied(await send('still one millisecond inside the window'));
    assert.equal(lookup.mock.callCount(), before, 'no repeat rate query while certainly blocked');
    t.mock.timers.tick(1);
    assert.ok((await send('accepted exactly at window expiry')).result);
    assert.equal(lookup.mock.callCount(), before + 1);
    denied(await send('establishes the next exhausted window'));
    await patch({ perMinute: 2 });
    assert.ok((await send('settings take effect immediately')).result);
  } finally { await app.close(); }
});
