import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { bearer, openSse, rawFetch, startTestHub, tempDir, TEST_TOKEN, waitFor, type TestHub } from './helpers.ts';

const reader = `
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
let initial; const changes = [];
createInterface({input:process.stdin}).on('line', (line) => {
  const m=JSON.parse(line);
  if(m.method==='initialize') {
    initial=m.params;
    setTimeout(()=>send({id:m.id,result:{apiVersion:1}}),existsSync('slow-init')?600:0);
  } else if(m.method==='shutdown') send({id:m.id,result:{}});
  else if(m.method==='config.changed') changes.push(m.params);
  else if(m.method==='invoke') {
    if(m.params.command==='report') send({method:'config.errors',params:m.params.arguments});
    send({id:m.id,result:m.params.command==='inspect'?{initial,changes}:{}});
  }
});
`;

const fields = [
  { name: 'title', type: 'text', label: '标题', scope: 'global', default: '简报' },
  { name: 'groupOwner', type: 'member', label: '负责人', scope: 'cluster' },
  { name: 'text', type: 'text', label: '文字', scope: 'cluster', default: '每周' },
];

function fixture(groups = ['one', 'two', 'other'], granted: string[] = ['one']) {
  const dir = tempDir();
  const home = join(dir, 'home');
  mkdirSync(home);
  const seed = new Store(join(dir, 'test.db'));
  try {
    for (const id of groups) seed.insertCluster({ id, name: id, category: '', createdAt: '2026-01-01' }, [{
      id: id + '-member', clusterId: id, name: id + '成员', avatar: null, harness: 'mock', model: null, effort: null,
      workerSessionId: id + '-session', cwd: dir, origin: 'attached', removedAt: null,
    }]);
  } finally { seed.close(); }
  const plugins = ['prefs', 'legacy'].map((id) => {
    const folder = join(dir, id);
    mkdirSync(folder);
    writeFileSync(join(folder, 'main.mjs'), reader);
    const manifest = join(folder, 'orrery-plugin.json');
    writeFileSync(manifest, JSON.stringify({ id, apiVersion: 1, version: '1.0.0', entry: 'main.mjs',
      permissions: ['clusters.read', 'messages.send'], commands: [{ id: 'inspect', title: 'Inspect' }, { id: 'report', title: 'Report' }],
      ...(id === 'prefs' ? { config: fields } : {}) }));
    return { manifest, permissions: ['clusters.read', 'messages.send'], clusterIds: granted, writeClusterIds: groups.includes('two') ? ['two'] : [] };
  });
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins }));
  return dir;
}

async function answer(app: TestHub, method: string, path: string, body?: unknown, headers = bearer(TEST_TOKEN)) {
  const res = await rawFetch(app.url + path, { method, headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json() };
}

const route = '/api/plugins/prefs/config';
const groupRoute = (id: string) => route + '?clusterId=' + encodeURIComponent(id);
const invoke = async (app: TestHub, id: string, command: string, args: Record<string, unknown> = {}) =>
  (await app.api('POST', `/api/plugins/${id}/invoke`, { command, arguments: args })).result;

test('configuration is user-only, scoped and versioned; reports stay on the field, SSE carries only metadata', async () => {
  const dir = fixture();
  const app = await startTestHub({ dir });
  const canary = 'weekly-preference-for-the-owner';
  const reason = '插件要求使用更短的标题';
  const stream = openSse(app.url + '/api/stream', bearer(TEST_TOKEN));
  try {
    assert.equal(await stream.status, 200);
    for (const path of [route, groupRoute('one'), '/api/clusters/one/plugin-configs']) {
      assert.equal((await answer(app, 'GET', path, undefined, { authorization: '' })).status, 401);
    }
    assert.equal((await answer(app, 'PUT', route, { revision: 0, values: {} }, bearer('unrelated-credential'))).status, 401);
    const rows = (await app.api('GET', '/api/plugins')).installed;
    assert.deepEqual(rows.find((p: any) => p.id === 'prefs').configScopes, ['global', 'cluster']);
    assert.ok(!Object.hasOwn(rows.find((p: any) => p.id === 'legacy'), 'configScopes'));
    assert.ok(!Object.hasOwn((await invoke(app, 'legacy', 'inspect')).initial, 'config'));
    assert.equal((await answer(app, 'GET', '/api/plugins/legacy/config')).status, 404);
    assert.deepEqual((await app.api('GET', '/api/clusters/two/plugin-configs')).plugins.map((p: any) => p.id), ['prefs']);
    assert.deepEqual((await app.api('GET', '/api/clusters/other/plugin-configs')).plugins, []);
    assert.equal((await answer(app, 'GET', groupRoute('other'))).status, 404);

    const initial = (await invoke(app, 'prefs', 'inspect')).initial.config;
    assert.deepEqual(initial, {global:{revision:0,values:{title:'简报'}},clusterDefaults:{text:'每周'},clusters:{}});
    const global = await app.api('GET', route);
    assert.deepEqual(global.clusters.map((c: any) => c.id), ['one', 'two']);
    assert.deepEqual(global.defaults, { title: '简报' });
    assert.deepEqual(global.overriddenFields, []);
    const group = await app.api('GET', groupRoute('two'));
    assert.deepEqual(group.members, [{ id:'two-member', name:'two成员', clusterId:'two' }]);
    const bad = await answer(app, 'PUT', groupRoute('two'), { revision: 0, values: {groupOwner:'one-member'} });
    assert.deepEqual([bad.status, bad.data.code, bad.data.field], [400, 'CONFIG_INVALID', 'groupOwner']);
    const saved = await app.api('PUT', route, { revision: 0, values: {title:canary} });
    assert.deepEqual([saved.revision, saved.values], [1, {title:canary}]);
    assert.deepEqual(saved.overriddenFields, ['title']);
    const conflict = await answer(app, 'PUT', route, {revision:0,values:{}});
    assert.deepEqual([conflict.status, conflict.data.code], [409, 'CONFIG_CONFLICT']);
    await app.api('PUT', groupRoute('two'), {revision:0,values:{groupOwner:'two-member'}});
    const updates = (await invoke(app, 'prefs', 'inspect')).changes;
    assert.deepEqual(updates, [
      {clusterId:null,revision:1,values:{title:canary}},
      {clusterId:'two',revision:1,values:{groupOwner:'two-member',text:'每周'}},
    ]);
    await invoke(app, 'prefs', 'report', {clusterId:null,revision:0,errors:{title:'过期'}});
    await invoke(app, 'prefs', 'report', {clusterId:null,revision:1,errors:{groupOwner:'错误范围'}});
    await invoke(app, 'prefs', 'report', {clusterId:'other',revision:0,errors:{text:'未授权'}});
    assert.deepEqual((await app.api('GET', route)).errors, {});
    await invoke(app, 'prefs', 'report', {clusterId:null,revision:1,errors:{title:reason}});
    assert.deepEqual((await app.api('GET', route)).errors, {title:reason});
    await waitFor(() => stream.events.filter((e) => e.event === 'plugin-config').length >= 3, 'config notices');
    for (const {data} of stream.events.filter((e) => e.event === 'plugin-config')) {
      assert.deepEqual(Object.keys(data).sort(), ['clusterId','pluginId','revision']);
    }
    assert.ok(!JSON.stringify(stream.events).includes(canary) && !JSON.stringify(stream.events).includes(reason));
    const log = JSON.stringify(app.store.listEvents(0));
    assert.ok(!log.includes(canary) && !log.includes(reason));
    const second = await app.api('PUT', route, {revision:1,values:{title:canary}});
    assert.deepEqual(second.errors, {});
    await invoke(app, 'prefs', 'report', {clusterId:null,revision:2,errors:{title:reason}});
    await app.api('POST','/api/plugins/prefs/restart',{});
    assert.deepEqual((await app.api('GET',route)).errors,{});
  } finally { stream.close(); await app.close(); }
  const again = await startTestHub({ dir });
  try {
    const snapshot = (await invoke(again, 'prefs', 'inspect')).initial.config;
    assert.deepEqual(snapshot.global, {revision:2, values:{title:canary}});
    assert.deepEqual(snapshot.clusters, {two:{revision:1,values:{groupOwner:'two-member',text:'每周'}}});
    assert.deepEqual((await again.api('GET',route)).errors,{});
  } finally { await again.close(); }
});

test('a save during initialization reaches the new instance even without a second notification opt-in', async () => {
  const dir = fixture();
  const app = await startTestHub({dir});
  try {
    writeFileSync(join(dir,'prefs','slow-init'),'1');
    const restart = app.api('POST', '/api/plugins/prefs/restart', {});
    await waitFor(async () => (await app.api('GET','/api/plugins')).installed.some((p: any) => p.id === 'prefs' && p.runtime.state === 'starting'), 'initializing plugin');
    await app.api('PUT', route, {revision:0,values:{title:'第一次'}});
    await app.api('PUT', route, {revision:1,values:{title:'最新值'}});
    await restart;
    const {initial,changes} = await invoke(app,'prefs','inspect');
    assert.equal(initial.config.global.revision,0);
    assert.deepEqual(changes,[{clusterId:null,revision:2,values:{title:'最新值'}}]);
  } finally {await app.close();}
});

test('an oversize initialize snapshot is refused before storage; accepted scopes remain usable on restart', async () => {
  const groups = Array.from({length:18}, (_,i) => 'group-' + i);
  const dir = fixture(groups,groups);
  const app = await startTestHub({dir});
  try {
    const text = '字'.repeat(1700);
    let accepted=0;
    for (const id of groups) {
      const result = await answer(app,'PUT',groupRoute(id),{revision:0,values:{text}});
      if (result.status !== 200) {
        assert.deepEqual([result.status,result.data.code],[400,'CONFIG_TOO_LARGE']);
        assert.equal((await app.api('GET', groupRoute(id))).revision,0);
        break;
      }
      accepted++;
    }
    assert.ok(accepted > 0 && accepted < groups.length, 'some scopes fit; the first that exceeds the frame does not');
    const rows = (await app.api('POST','/api/plugins/prefs/restart',{})).installed;
    assert.equal(rows.find((p: any) => p.id==='prefs').runtime.state,'ready');
    assert.equal((await app.api('GET',groupRoute(groups[0]))).values.text,text);
  } finally {await app.close();}
});
