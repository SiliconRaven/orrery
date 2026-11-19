// Files and skills (docs/files.md): upload and download over HTTP, attachments on messages, what members are told,
// MCP send_message attachments (native only), and the skills listing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { FileStore, MAX_FILE_BYTES, outboxName, sanitizeName, sniffImage } from '../src/core/files.ts';
import { listSkills, parseFrontmatter, skillRefs } from '../src/core/skills.ts';
import { Store } from '../src/core/store.ts';
import { bearer, holdScript, startTestHub, tempDir, TEST_TOKEN, waitFor, type TestHub, turnsOf, memberHeaders } from './helpers.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');

async function upload(app: TestHub, clusterId: string, name: string, data: Buffer, headers: Record<string, string> = {}) {
  const res = await fetch(`${app.url}/api/files?cluster=${encodeURIComponent(clusterId)}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-orrery-filename': encodeURIComponent(name), ...headers }, body: new Uint8Array(data),
  });
  return { status: res.status, data: await res.json() };
}

/** Raw HTTP: lets a test declare a Content-Length it never sends. */
function raw(url: string, path: string, headers: Record<string, string>, body = '') {
  return new Promise<number>((ok, fail) => {
    const req = request(url + path, { method: 'POST', headers: { ...bearer(TEST_TOKEN), ...headers } }, (res) => { res.resume(); ok(res.statusCode!); });
    req.on('error', fail);
    req.end(body);
  });
}

/** One MCP tools/call over the bridge secret as native member session `session` of harness mock. */
async function nativeCall(app: TestHub, session: string, name: string, args: Record<string, unknown>) {
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  return mcpCall(app, { 'x-orrery-bridge': secret, 'x-orrery-session': session, 'x-orrery-harness': 'mock' }, name, args);
}

async function mcpCall(app: TestHub, headers: Record<string, string>, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const { result } = await res.json();
  return { isError: result.isError === true, text: result.content[0].text as string };
}

/** A cluster with member N (mock session s1, attached) and member I (a new conversation). */
async function mixed(app: TestHub) {
  const { cluster, members: [n, i] } = await app.api('POST', '/api/clusters', {
    name: 'files', members: [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'N' }, { harness: 'mock', mode: 'native', name: 'I', projectPath: '/work' }],
  });
  return { cluster, n, i };
}

test('files: names are sanitized to one safe segment; images are known by their magic bytes only', () => {
  assert.equal(sanitizeName('report.pdf'), 'report.pdf');
  assert.equal(sanitizeName('..\\..\\secret'), '_.._secret');
  assert.equal(sanitizeName('a/b:c*?.txt'), 'a_b_c__.txt');
  assert.equal(sanitizeName(' .hidden. '), 'hidden');
  assert.equal(sanitizeName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeName('报告\u0000‮.png'), '报告__.png');
  assert.ok([...sanitizeName(`${'长'.repeat(300)}.markdown`)].length <= 120);
  assert.match(sanitizeName(`${'x'.repeat(300)}.markdown`), /\.markdown$/);
  for (const bad of ['', '...', '/', 42, null]) assert.throws(() => sanitizeName(bad), /file name/);

  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  for (const not of [SVG, HTML, Buffer.from('%PDF-1.7'), Buffer.alloc(0), Buffer.from('RIFF\0\0\0\0WAVE')]) assert.equal(sniffImage(not), null);
});

test('files: a stream over 20 MB is refused and leaves nothing behind', async () => {
  const dir = tempDir();
  const store = new Store(':memory:');
  store.insertCluster({ id: 'c1', name: 'c', createdAt: new Date().toISOString(), category: '' }, []);
  const files = new FileStore(store, { dir: join(dir, 'files'), outbox: join(dir, 'outbox'), protectedFiles: [] });
  async function* big() {
    for (let sent = 0; sent <= MAX_FILE_BYTES; sent += 1024 * 1024) yield Buffer.alloc(1024 * 1024);
  }
  await assert.rejects(files.save('c1', 'user', 'big.bin', big()), /larger than 20 MB/);
  assert.deepEqual(readdirSync(join(dir, 'files')), [], 'the partial copy was removed');
  assert.deepEqual(store.db.prepare('SELECT * FROM files').all(), []);
  await assert.rejects(files.save('nope', 'user', 'a.txt', big()), /unknown cluster/);
  const ok = await files.save('c1', 'user', 'a.txt', (async function* () { yield Buffer.from('hi'); })());
  assert.deepEqual([ok.size, ok.mime, ok.sha256.length], [2, 'application/octet-stream', 64]);
  store.close();
});

test('files: upload is octet-stream only, same-origin, size-checked; download is by id, inline only for real raster images', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.cluster('up', ['A']);
    const port = new URL(app.url).port;
    const host = `127.0.0.1:${port}`;
    const path = `/api/files?cluster=${cluster.id}`;

    // The CSRF rule: JSON or a "simple" type is refused here, octet-stream is refused elsewhere, a foreign Origin is refused.
    for (const type of ['text/plain', 'application/json', 'multipart/form-data; boundary=x']) {
      assert.equal(await raw(app.url, path, { host, 'content-type': type, 'x-orrery-filename': 'a.txt' }, 'x'), 415, type);
    }
    assert.equal(await raw(app.url, '/api/pause', { host, 'content-type': 'application/octet-stream' }, '{"paused":true}'), 415);
    assert.equal(await raw(app.url, path, { host, origin: 'https://evil.example', 'content-type': 'application/octet-stream', 'x-orrery-filename': 'a.txt' }, 'x'), 403);
    // Declared too large: refused before reading.
    assert.equal(await raw(app.url, path, { host, 'content-type': 'application/octet-stream', 'x-orrery-filename': 'a.txt', 'content-length': String(MAX_FILE_BYTES + 1) }), 413);
    assert.equal((await upload(app, cluster.id, '', Buffer.from('x'))).status, 400);
    assert.equal((await upload(app, cluster.id, 'a.txt', Buffer.from('x'), { 'x-orrery-filename': '%E0%A4%A' })).status, 400);
    assert.equal((await upload(app, 'no-such-cluster', 'a.txt', Buffer.from('x'))).status, 400);

    const png = await upload(app, cluster.id, '截图 1.png', PNG);
    assert.equal(png.status, 201);
    assert.deepEqual([png.data.name, png.data.mime, png.data.size, png.data.uploader, png.data.clusterId], ['截图 1.png', 'image/png', PNG.length, 'user', cluster.id]);
    assert.ok(!JSON.stringify(png.data).includes(app.home), 'no local path in the answer');
    const svg = await upload(app, cluster.id, 'logo.png', SVG);           // an SVG named .png
    const html = await upload(app, cluster.id, 'page.png', HTML);        // HTML named .png
    const evil = await upload(app, cluster.id, '../../secret', Buffer.from('x'));
    assert.equal(evil.data.name, '_.._secret');
    assert.ok(existsSync(join(app.home, 'files', evil.data.id, '_.._secret')), 'stored under its own id folder');

    const get = (id: string, q = '') => fetch(`${app.url}/api/files/${id}${q}`);
    const strict = (res: Response) => {
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
      assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    };
    const inline = await get(png.data.id);
    strict(inline);
    assert.equal(inline.headers.get('content-type'), 'image/png');
    assert.match(inline.headers.get('content-disposition')!, /^inline; filename="__ 1\.png"; filename\*=UTF-8''%E6%88%AA%E5%9B%BE%201\.png$/);
    assert.deepEqual(Buffer.from(await inline.arrayBuffer()), PNG);
    const asDownload = await get(png.data.id, '?download=1');
    strict(asDownload);
    assert.equal(asDownload.headers.get('content-type'), 'application/octet-stream');
    assert.match(asDownload.headers.get('content-disposition')!, /^attachment;/);
    await asDownload.body?.cancel();
    for (const f of [svg, html]) {
      const res = await get(f.data.id);
      strict(res);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream', `${f.data.name} is not served inline`);
      assert.match(res.headers.get('content-disposition')!, /^attachment;/);
      await res.body?.cancel();
    }
    // Lookup by id only: anything else is unknown, never a path.
    for (const id of ['nope', '..%2F..%2Fsecret', encodeURIComponent(join(app.home, 'secret')), png.data.id.toUpperCase(), '00000000-0000-0000-0000-000000000000']) {
      const res = await get(id);
      assert.equal(res.status, 404, id);
      await res.body?.cancel();
    }
  } finally {
    await app.close();
  }
});

test('files: messages carry attachments of their own cluster; the event and the history list them', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [a] } = await app.cluster('one', ['A']);
    const { cluster: other } = await app.cluster('two', ['B']);
    const f1 = (await upload(app, cluster.id, 'a.txt', Buffer.from('hello'))).data;
    const f2 = (await upload(app, cluster.id, 'b.png', PNG)).data;
    const foreign = (await upload(app, other.id, 'c.txt', Buffer.from('x'))).data;
    const send = (body: unknown) => fetch(`${app.url}/api/clusters/${cluster.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, data: await r.json() }));

    assert.match((await send({ body: 'x', attachments: [foreign.id] })).data.error, /unknown file/, 'another cluster’s file');
    assert.match((await send({ body: 'x', attachments: ['00000000-0000-0000-0000-000000000000'] })).data.error, /unknown file/);
    assert.match((await send({ body: 'x', attachments: [f1.id, f1.id] })).data.error, /distinct/);
    assert.match((await send({ body: 'x', attachments: Array.from({ length: 11 }, () => f1.id) })).data.error, /at most 10/);
    assert.match((await send({ body: 'x', attachments: f1.id })).data.error, /array/);
    assert.match((await send({ body: '  ' })).data.error, /body is required/);

    const sent = await send({ body: '', attachments: [f2.id, f1.id] });   // files alone are a message
    assert.equal(sent.status, 201);
    const listed = (await app.messages(cluster.id)).find((m) => m.id === sent.data.id)!;
    assert.deepEqual(listed.attachments.map((f: any) => f.name), ['b.png', 'a.txt'], 'in the order attached');
    const event = app.events.find((e) => e.kind === 'message' && (e.payload as any).message.id === sent.data.id)!;
    assert.deepEqual((event.payload as any).attachments.map((f: any) => f.id), [f2.id, f1.id]);
    const plain = await send({ body: '@A hi' });
    assert.equal((await app.messages(cluster.id)).find((m) => m.id === plain.data.id)!.attachments, undefined, 'no field without files');
    void a;
  } finally {
    await app.close();
  }
});

test('files: members get name, size and path; direct messages append the lines', async () => {
  const app = await startTestHub();
  try {
    const { cluster, n, i } = await mixed(app);
    const toN = () => app.native.delivered.filter((d) => d.sessionId === 's1');
    const f = (await upload(app, cluster.id, 'notes.txt', Buffer.alloc(1536, 'a'))).data;
    const stored = join(app.home, 'files', f.id, 'notes.txt');
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@all see attached', attachments: [f.id] });
    await waitFor(() => app.settled(cluster.id), 'delivered');

    const toI = app.store.getMember(i.id)!.workerSessionId;
    assert.deepEqual(app.native.delivered.map((d) => d.sessionId).sort(), ['s1', toI].sort(), 'one envelope each');
    for (const { text } of app.native.delivered) {
      assert.ok(text.includes(`\n@all see attached\n[orrery 附件] notes.txt（1.5 KB）：${stored}`), text);
      assert.match(text, /附件是本机文件，用你自己的工具按上面的路径读取。要发文件：/);
      assert.ok(text.includes(`clusterId=${cluster.id} from=`), 'the envelope identifies its cluster');
      assert.ok(text.includes(`这个群的 clusterId 是 ${cluster.id}；调用 orrery 工具时可带 clusterId 指定群。`));
    }

    // The member page of a native member: no envelope, body as typed, then the attachment line.
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'just you', to: [n.id], attachments: [f.id] });
    await waitFor(() => toN().length === 2, 'direct delivery');
    assert.equal(toN()[1].text, `just you\n[orrery 附件] notes.txt（1.5 KB）：${stored}`);
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '', to: [n.id], attachments: [f.id] });
    await waitFor(() => toN().length === 3, 'files-only direct delivery');
    assert.equal(toN()[2].text, `[orrery 附件] notes.txt（1.5 KB）：${stored}`);
  } finally {
    await app.close();
  }
});

test('files: outbox names are bare file names; paths, .., drives, UNC and streams are refused', () => {
  assert.equal(outboxName('design.md'), 'design.md');
  assert.equal(outboxName('报告 v2.pdf'), '报告 v2.pdf');
  for (const bad of ['', '.', '..', '../x.txt', 'a/b.txt', 'a\\b.txt', 'C:\\x.txt', 'C:x.txt', '\\\\server\\share\\x.txt', '//server/share/x',
    'x.txt:secret', 'x.txt::$DATA', 'CON', 'nul.txt', ' x.txt', 'x.txt.', 'a\u0000b', 'a\u202eb', 'a*b', 42, null]) {
    assert.throws(() => outboxName(bad), /bare name of a file in the orrery outbox/, JSON.stringify(bad));
  }
  for (const remote of ['\\\\?\\C:\\x.txt', '\\\\?\\UNC\\host\\share\\x', '\\\\.\\pipe\\x', '\\\\203.0.113.1\\share\\x.txt', '//203.0.113.1/share/x.txt']) {
    assert.throws(() => outboxName(remote), /bare name/, remote);
  }
});

test('files: a remote or extended path is refused by its string, before any filesystem call', async () => {
  const store = new Store(':memory:');
  store.insertCluster({ id: 'c1', name: 'c', createdAt: new Date().toISOString(), category: '' }, []);
  const dir = tempDir();
  const files = new FileStore(store, { dir: join(dir, 'files'), outbox: join(dir, 'outbox'), protectedFiles: [] });
  // importFromOutbox validates the name first (src/core/files.ts); an unroutable test address would hang if it were opened.
  const started = Date.now();
  for (const remote of ['\\\\203.0.113.1\\share\\x.txt', '\\\\?\\UNC\\203.0.113.1\\share\\x.txt', '//203.0.113.1/share/x.txt']) {
    await assert.rejects(files.importFromOutbox('c1', 'm', remote), /bare name/);
  }
  assert.ok(Date.now() - started < 500, 'no network wait');
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'files.ts'), 'utf8');
  const body = src.slice(src.indexOf('async importFromOutbox('));
  assert.ok(body.indexOf('outboxName(name)') < body.search(/\b(lstat|realpath|open|stat)\(/), 'the name check comes before any fs call');
  store.close();
});

/** A cluster with members A (session s1) and B (session s2), and I (a new conversation). */
async function twoNative(app: TestHub) {
  const { cluster, members: [a, b, i] } = await app.api('POST', '/api/clusters', {
    name: 'outbox', members: [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }, { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
      { harness: 'mock', mode: 'native', name: 'I', projectPath: '/work' },
    ],
  });
  return { cluster, a, b, i };
}

test('files: get_task gives a task\u2019s attachments the message-attachment shape with the path; list_tasks stays without them', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  try {
    const { cluster, i } = await mixed(app);
    const png = (await upload(app, cluster.id, 'shot.png', PNG)).data;
    const txt = (await upload(app, cluster.id, 'notes.txt', Buffer.from('hello'))).data;
    const { task } = await app.api('POST', `/api/clusters/${cluster.id}/collaboration`, {
      action: 'task.create', operationId: 'with-files', title: 't', scope: 's', acceptance: 'a', memberId: null, fileIds: [txt.id, png.id],
    });
    const native = JSON.parse((await nativeCall(app, 's1', 'get_task', { taskId: task.id })).text);
    const paths = [join(app.home, 'files', txt.id, 'notes.txt'), join(app.home, 'files', png.id, 'shot.png')];
    assert.deepEqual(native.attachments, [{ name: 'notes.txt', size: 5, path: paths[0] }, { name: 'shot.png', size: PNG.length, path: paths[1] }]);
    assert.ok(paths.every((path) => existsSync(path)), 'the agent can read the path');
    assert.deepEqual(native.task.fileIds, [txt.id, png.id]);

    const created = JSON.parse((await mcpCall(app, memberHeaders(app, i.id), 'get_task', { taskId: task.id })).text);
    assert.deepEqual(created.attachments, native.attachments, 'a created conversation gets the paths too');

    const detail = await app.api('GET', `/api/clusters/${cluster.id}/tasks/${task.id}`);
    assert.deepEqual(detail.attachments.map((f: any) => [f.id, f.mime]), [[txt.id, 'application/octet-stream'], [png.id, 'image/png']], 'the page gets ids and types');
    assert.ok(detail.attachments.every((f: any) => !('path' in f)), 'never a local path over HTTP');

    const listed = JSON.parse((await nativeCall(app, 's1', 'list_tasks', {})).text);
    assert.ok(!('fileIds' in listed.tasks[0]) && !('attachments' in listed.tasks[0]), 'the summary leaves them out');
    hold.release();
  } finally {
    await app.close();
  }
});

test('files: MCP attachments come only from the caller’s own outbox folder; real copies only; the outbox is never changed', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  try {
    const { cluster, a, b, i } = await twoNative(app);
    // The envelope tells each native member its own folder (and creates it).
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A @B hi' });
    await waitFor(() => app.native.delivered.length === 2, 'deliveries');
    const boxA = join(app.home, 'outbox', a.id);
    const boxB = join(app.home, 'outbox', b.id);
    const toA = app.native.delivered.find((d) => d.sessionId === 's1')!.text;
    assert.ok(toA.includes(`你的 orrery 发件箱 ${boxA}，再在 send_message`), toA);
    assert.ok(!toA.includes(boxB));
    assert.ok(existsSync(boxA) && existsSync(boxB));

    writeFileSync(join(boxA, 'design.md'), '# design');
    writeFileSync(join(boxA, 'huge.bin'), '');
    truncateSync(join(boxA, 'huge.bin'), MAX_FILE_BYTES + 1);   // sparse: refused by size before reading
    mkdirSync(join(boxA, 'folder'));
    const outside = tempDir();
    writeFileSync(join(outside, 'private.txt'), 'not for the chat');
    symlinkSync(outside, join(boxA, 'dirlink'), 'junction');    // a reparse point (no admin rights needed)
    let fileLink = false;
    try {
      symlinkSync(join(outside, 'private.txt'), join(boxA, 'filelink.txt'));
      fileLink = true;
    } catch { /* file symlinks need developer mode on Windows; the junction covers links */ }
    linkSync(join(outside, 'private.txt'), join(boxA, 'hardlink.txt'));   // a second name for a file outside
    linkSync(join(app.home, 'secret'), join(boxA, 'innocent.txt'));      // a second name for the secret

    const refused = async (session: string, attachments: unknown, re: RegExp) => {
      const r = await nativeCall(app, session, 'send_message', { body: 'file', attachments });
      assert.ok(r.isError && re.test(r.text), `${JSON.stringify(attachments)}: ${r.text}`);
    };
    // Paths are never opened: anything but a bare name is refused by its string.
    await refused('s1', [join(outside, 'private.txt')], /bare name/);
    await refused('s1', [join(boxA, 'design.md')], /bare name/);
    await refused('s1', ['..\\..\\secret'], /bare name/);
    await refused('s1', [`..\\${a.id}\\design.md`], /bare name/);
    await refused('s1', ['\\\\localhost\\c$\\x.txt'], /bare name/);
    await refused('s1', ['design.md:hidden'], /bare name/);
    await refused('s1', ['private.txt'], /not a file in your orrery outbox/);
    await refused('s1', ['missing.txt'], /not a file in your orrery outbox/);
    await refused('s1', ['folder'], /not a file in your orrery outbox/);
    await refused('s1', ['dirlink'], /is a link/);
    if (fileLink) await refused('s1', ['filelink.txt'], /is a link/);
    await refused('s1', ['hardlink.txt'], /more than one link/);
    await refused('s1', ['innocent.txt'], /database or secret/);
    await refused('s1', ['huge.bin'], /larger than 20 MB/);
    await refused('s1', ['design.md', 'missing.txt'], /not a file/);   // all or nothing
    await refused('s1', ['design.md', 'design.md'], /distinct/);
    // B cannot send A's staged file: B's folder is its own, chosen by who B is.
    await refused('s2', ['design.md'], new RegExp(`not a file in your orrery outbox .*${b.id}`));
    assert.deepEqual(app.store.db.prepare('SELECT * FROM files').all(), [], 'refused attaches keep no copies');

    const ok = await nativeCall(app, 's1', 'send_message', { body: 'record only', attachments: ['design.md'] });
    assert.equal(ok.isError, false, ok.text);
    const msg = (await app.messages(cluster.id)).at(-1)!;
    assert.deepEqual(msg.attachments.map((f: any) => [f.name, f.uploader, f.size]), [['design.md', a.id, 8]]);
    const copy = join(app.home, 'files', msg.attachments[0].id, 'design.md');
    assert.equal(readFileSync(copy, 'utf8'), '# design');
    // Copy only: the staged file stays; rewriting it in place afterwards is the sender's business, never lost.
    assert.equal(readFileSync(join(boxA, 'design.md'), 'utf8'), '# design', 'left in the outbox');
    writeFileSync(join(boxA, 'design.md'), '# design v2');
    const again = await nativeCall(app, 's1', 'send_message', { body: 'v2', attachments: ['design.md'] });
    assert.equal(again.isError, false, again.text);
    assert.equal(readFileSync(join(boxA, 'design.md'), 'utf8'), '# design v2', 'nothing is deleted');
    assert.equal(readFileSync(copy, 'utf8'), '# design', 'the first copy is unchanged');
    assert.ok(existsSync(join(outside, 'private.txt')), 'nothing outside the outbox touched');

    // read_messages: every reader gets the path; another member's outbox is never read for the caller.
    const own = JSON.parse((await nativeCall(app, 's1', 'read_messages', { history: true })).text);
    assert.deepEqual(own.find((m: any) => m.body === 'record only').attachments, [{ name: 'design.md', size: 8, path: copy }]);
    const read = JSON.parse((await mcpCall(app, memberHeaders(app, i.id), 'read_messages', { history: true })).text);
    assert.deepEqual(read.find((m: any) => m.body === 'record only').attachments, [{ name: 'design.md', size: 8, path: copy }]);
    const before = app.store.db.prepare('SELECT COUNT(*) AS n FROM files').get()!.n;
    const other = await mcpCall(app, memberHeaders(app, i.id), 'send_message', { body: 'look', attachments: ['design.md'] });
    assert.ok(other.isError && /your orrery outbox/.test(other.text), other.text);
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM files').get()!.n, before, 'nothing was copied for the other member');
    hold.release();
  } finally {
    await app.close();
  }
});

test('files: an outbox folder that cannot be created never blocks delivery', async () => {
  const app = await startTestHub();
  try {
    const { cluster, n } = await mixed(app);
    const obstacle = join(app.home, 'outbox', n.id);
    writeFileSync(obstacle, 'a file where the folder should be');
    const first = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@N one' });
    await waitFor(() => app.native.delivered.length === 1, 'first message delivered despite the obstacle');
    assert.match(app.native.delivered[0].text, /发件箱现在建不起来，暂时不能发文件/);
    await waitFor(async () => (await app.messages(cluster.id)).find((m) => m.id === first.id)?.deliveries[0].state === 'done', 'first done');
    unlinkSync(obstacle);
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@N two' });
    await waitFor(() => app.native.delivered.length === 2, 'next message delivered (the member was released)');
    assert.ok(app.native.delivered[1].text.includes(`你的 orrery 发件箱 ${obstacle}，`), app.native.delivered[1].text);
  } finally {
    await app.close();
  }
});

test('files: a send refused after the copy (hop limit) drops the Hub copy and keeps the source', async () => {
  const app = await startTestHub({ limits: { maxHops: 0 } });
  try {
    const { cluster, n } = await mixed(app);
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@N go' });
    await waitFor(() => app.settled(cluster.id), 'delivered');   // N now handles a hop-0 message: its reply would be hop 1
    writeFileSync(join(app.home, 'outbox', n.id, 'r.txt'), 'x');
    const r = await nativeCall(app, 's1', 'send_message', { body: 'reply', attachments: ['r.txt'] });
    assert.ok(r.isError && /exceeds the limit/.test(r.text), r.text);
    assert.deepEqual(app.store.db.prepare('SELECT * FROM files').all(), []);
    assert.deepEqual(readdirSync(join(app.home, 'files')), []);
    assert.equal(readFileSync(join(app.home, 'outbox', n.id, 'r.txt'), 'utf8'), 'x', 'source kept');
  } finally {
    await app.close();
  }
});

/** A FileStore over a fresh folder with cluster c1, and member m's outbox folder. */
function outboxStore(Kind: typeof FileStore = FileStore) {
  const store = new Store(':memory:');
  store.insertCluster({ id: 'c1', name: 'c', createdAt: new Date().toISOString(), category: '' }, []);
  const dir = tempDir();
  const files = new Kind(store, { dir: join(dir, 'files'), outbox: join(dir, 'outbox'), protectedFiles: [] });
  const member = '11111111-1111-4111-8111-111111111111';
  return { store, dir, files, member, box: files.memberOutbox(member) };
}

test('files: a file swapped between the check and the open is not read', async () => {
  let swap = async () => {};
  class Swapping extends FileStore {
    protected override async openStaged(path: string) {
      await swap();
      return super.openStaged(path);
    }
  }
  const { store, dir, files, member, box } = outboxStore(Swapping);
  writeFileSync(join(box, 'a.txt'), 'checked');
  writeFileSync(join(dir, 'other.txt'), 'swapped in');
  swap = async () => {   // after the checks: another file now has the name
    unlinkSync(join(box, 'a.txt'));
    copyFileSync(join(dir, 'other.txt'), join(box, 'a.txt'));
  };
  await assert.rejects(files.importFromOutbox('c1', member, 'a.txt'), /changed while it was being checked/);
  assert.deepEqual(store.db.prepare('SELECT * FROM files').all(), []);
  store.close();
});

test('files: an outbox root or member folder replaced or turned into a junction is refused, not followed', async () => {
  const { store, dir, files, member, box } = outboxStore();
  writeFileSync(join(box, 'a.txt'), 'x');
  assert.equal((await files.importFromOutbox('c1', member, 'a.txt')).size, 1, 'a normal copy works');

  // The member folder becomes a junction to a folder elsewhere holding a file of the same name.
  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'a.txt'), 'elsewhere');
  rmSync(box, { recursive: true });
  symlinkSync(elsewhere, box, 'junction');
  await assert.rejects(files.importFromOutbox('c1', member, 'a.txt'), /is missing or is a link/);
  rmSync(box);

  // The root is replaced by another folder (new identity), even one holding the same layout.
  const root = join(dir, 'outbox');
  renameSync(root, join(dir, 'old-outbox'));
  mkdirSync(join(root, member), { recursive: true });
  writeFileSync(join(root, member, 'a.txt'), 'x');
  await assert.rejects(files.importFromOutbox('c1', member, 'a.txt'), /was replaced or is a link/);
  // … or by a junction to the old one.
  rmSync(root, { recursive: true });
  symlinkSync(join(dir, 'old-outbox'), root, 'junction');
  await assert.rejects(files.importFromOutbox('c1', member, 'a.txt'), /was replaced or is a link/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM files').get()!.n, 1, 'only the first, normal copy');
  store.close();
});

test('skills: frontmatter name/description, folder-name fallback, unreadable and invalid ones skipped', () => {
  assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: "Does a: things"\n---\nbody'), { name: 'a', description: 'Does a: things' });
  assert.deepEqual(parseFrontmatter('---\r\nname: b\r\ndescription: >\r\n  line one\r\n  line two\r\nother: x\r\n---\r\n'), { name: 'b', description: 'line one line two' });
  assert.deepEqual(parseFrontmatter('no frontmatter'), {});

  const dir = tempDir();
  const skill = (folder: string, text: string | null) => {
    mkdirSync(join(dir, folder), { recursive: true });
    if (text !== null) writeFileSync(join(dir, folder, 'SKILL.md'), text);
  };
  skill('ponytail', '---\nname: ponytail\ndescription: Lazy senior dev mode.\n---\n# body is never read out');
  skill('folder-name', '---\ndescription: no name given\n---\n');
  skill('bad', '---\nname: "has space"\n---\n');                 // invalid name → the folder name
  skill('empty', null);                                          // no SKILL.md → skipped
  skill('wei rd', '---\ndescription: x\n---\n');                 // neither name valid → skipped
  skill('long', `---\nname: long\ndescription: ${'d'.repeat(1000)}\n---\n`);
  writeFileSync(join(dir, 'loose.md'), 'not a folder');
  const listed = listSkills(dir);
  assert.deepEqual(listed.map((s) => s.name), ['bad', 'folder-name', 'long', 'ponytail']);
  assert.equal(listed.find((s) => s.name === 'ponytail')!.description, 'Lazy senior dev mode.');
  assert.equal([...listed.find((s) => s.name === 'long')!.description].length, 300);
  assert.ok(!JSON.stringify(listed).includes('never read out'), 'nothing but name and description');
  assert.deepEqual(listSkills(join(dir, 'missing')), []);
  assert.deepEqual(listSkills(undefined), []);

  const names = new Set(['ponytail', 'ponytail-review', 'a.b']);
  assert.deepEqual(skillRefs('use $ponytail-review, then $ponytail. and $a.b; not x$ponytail or $$ponytail or $unknown', names),
    ['ponytail-review', 'ponytail', 'a.b']);
  assert.deepEqual(skillRefs('$ponytail用一下 $ponytail', names), ['ponytail']);
});

test('skills: GET /api/skills lists the folder; the envelope names the skills a body uses, the body unchanged', async () => {
  const dir = tempDir();
  const skills = join(dir, 'skills');
  mkdirSync(join(skills, 'ponytail'), { recursive: true });
  writeFileSync(join(skills, 'ponytail', 'SKILL.md'), '---\nname: ponytail\ndescription: Lazy mode.\n---\n');
  const app = await startTestHub({ dir, skillsDir: skills });
  try {
    assert.deepEqual(await app.api('GET', '/api/skills'), [{ name: 'ponytail', description: 'Lazy mode.' }]);
    const { cluster } = await mixed(app);
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@N try $ponytail and $nothing', attachments: undefined });
    await waitFor(() => app.settled(cluster.id), 'delivered');
    const text = app.native.delivered.at(-1)!.text;
    assert.ok(text.includes('\n@N try $ponytail and $nothing\n'), 'body unchanged');
    assert.match(text, /消息里的 \$ponytail 是 skill：请在你自己的应用里使用它。/);
    assert.ok(text.includes(`这个群的 clusterId 是 ${cluster.id}；调用 orrery 工具时可带 clusterId 指定群。`));
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@N no skills here' });
    await waitFor(() => app.native.delivered.length === 2, 'second delivery');
    assert.doesNotMatch(app.native.delivered[1].text, /是 skill/);
  } finally {
    await app.close();
  }
});
