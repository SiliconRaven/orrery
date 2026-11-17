import { tempDir } from './helpers.ts';
// The page's history search, GET /api/clusters/:id/messages/search (src/web/message-search.ts, Store.searchMessages):
// every criterion alone and combined, removed / hidden / same-name members, literal keywords, time bounds, paging with a
// stable cursor, the per-call scan cap, validation, auth, and no leak across clusters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bearer, rawFetch, startTestHub, TEST_TOKEN, type TestHub } from './helpers.ts';
import { searchClusterMessages, searchSnippet, SEARCH_SCAN_CAP } from '../src/web/message-search.ts';
import type { Message } from '../src/core/types.ts';

let clock = Date.UTC(2026, 0, 1);
/** Inserts one message (one minute after the previous one) and returns it. */
function put(app: TestHub, clusterId: string, from: string, body: string, extra: Partial<Message> = {}, fileIds: string[] = []): Message {
  const id = randomUUID();
  clock += 60_000;
  const message: Message = { id, clusterId, from, mentions: [], body, replyTo: null, chainId: id, hop: 0, createdAt: new Date(clock).toISOString(), ...extra };
  app.store.insertMessage(message, [], false, fileIds);
  return message;
}
const system = (systemKind: Message['systemKind']) => ({ kind: 'system' as const, systemKind });

async function setup() {
  const app = await startTestHub();
  app.hub.setPaused(true);
  const { cluster, members: [a, b, c, h] } = await app.cluster('search', ['a', 'b', 'c', 'h']);
  const other = (await app.cluster('other', ['x'])).cluster;
  return { app, cluster, a, b, c, h, other };
}

const ids = (answer: { items: { id: string }[] }) => answer.items.map((i) => i.id);

test('search: each criterion alone and combined, removed / hidden / same-name members, literal and ASCII-insensitive keywords', async () => {
  const { app, cluster, a, b, c, h, other } = await setup();
  try {
    const path = (query: string) => `/api/clusters/${cluster.id}/messages/search?${query}`;
    const get = (query: string) => app.api('GET', path(query));
    // A few hundred messages of filler, so the hits are spread through the history.
    const filler = Array.from({ length: 300 }, (_, i) => put(app, cluster.id, i % 2 ? a.id : 'user', `filler ${i}`));
    const fromA = put(app, cluster.id, a.id, 'Deploy the 50% build_now please');
    const fromC = put(app, cluster.id, c.id, 'c says DEPLOY too');
    const fromH = put(app, cluster.id, h.id, 'hidden member writes deploy');
    const user = put(app, cluster.id, 'user', '用户：部署到测试环境');
    const problem = put(app, cluster.id, 'system', '投递失败：deploy', system('delivery_failed'));
    const attention = put(app, cluster.id, 'system', '提醒：成员没有动静', system('stalled'));
    const task = put(app, cluster.id, 'system', '任务已创建', system('task'));
    const legacy = put(app, cluster.id, 'system', '没有类别的旧系统消息', { kind: 'system' });   // no systemKind: 其他
    put(app, cluster.id, 'system', '确认回执：deploy', system('receipt'));   // never found, as never shown in the chat
    const accent = put(app, cluster.id, b.id, 'Élan café ÉLAN');
    const fileId = randomUUID();
    app.store.insertFile({ id: fileId, clusterId: cluster.id, uploader: 'user', name: 'f.txt', mime: 'application/octet-stream', size: 1, sha256: 'x', createdAt: new Date().toISOString() });
    const withFile = put(app, cluster.id, 'user', 'see attachment', {}, [fileId]);
    put(app, other.id, 'user', 'deploy in another cluster');
    // c is removed, a new member takes its name; h is hidden.
    app.hub.removeMember(cluster.id, c.id);
    const { members: [c2] } = await app.hub.addMembers(cluster.id, [{ projectPath: tempDir(), harness: 'mock', name: 'c' }]);
    const fromC2 = put(app, cluster.id, c2.id, 'new c says deploy');
    app.hub.setMemberHidden(h.id, true);

    // Keyword: case-insensitive for ASCII, literal % and _, newest first by default; never another cluster's message.
    assert.deepEqual(ids(await get('q=deploy')), [fromC2.id, problem.id, fromH.id, fromC.id, fromA.id]);
    assert.deepEqual(ids(await get('q=deploy&order=asc')), [fromA.id, fromC.id, fromH.id, problem.id, fromC2.id], 'oldest first on request');
    assert.deepEqual(ids(await get(`q=${encodeURIComponent('50%')}`)), [fromA.id]);
    assert.deepEqual(ids(await get(`q=${encodeURIComponent('%')}`)), [fromA.id], '% is literal');
    assert.deepEqual(ids(await get('q=build_now')), [fromA.id]);
    assert.deepEqual(ids(await get('q=d_ploy')), [], '_ is literal');
    assert.deepEqual(ids(await get(`q=${encodeURIComponent('部署')}`)), [user.id], 'CJK: an exact substring');
    // SQLite's lower() and LIKE fold A–Z only: other letters match in the same case (what docs/collaboration-api.md promises).
    assert.deepEqual(ids(await get(`q=${encodeURIComponent('élan')}`)), [], 'É and é are different letters to SQLite');
    assert.deepEqual(ids(await get(`q=${encodeURIComponent('Élan')}`)), [accent.id]);
    assert.deepEqual(ids(await get(`q=${encodeURIComponent('CAFÉ')}`)), [], 'é vs É in the same word');
    assert.deepEqual(ids(await get(`q=${encodeURIComponent('CAFé')}`)), [accent.id], 'the ASCII part folds');

    // Sender by identity: the removed c and the new c are told apart; a hidden member's messages are the user's history too.
    assert.deepEqual(ids(await get(`sender=${c.id}`)), [fromC.id]);
    assert.deepEqual(ids(await get(`sender=${c2.id}`)), [fromC2.id]);
    assert.deepEqual(ids(await get(`sender=${h.id}`)), [fromH.id]);
    assert.deepEqual(ids(await get(`sender=user&q=${encodeURIComponent('部署')}`)), [user.id]);
    assert.deepEqual(ids(await get('sender=system')), [legacy.id, task.id, attention.id, problem.id], 'old receipts are left out');

    // System categories and warning levels.
    assert.deepEqual(ids(await get('category=warning')), [attention.id, problem.id]);
    assert.deepEqual(ids(await get('category=warning&level=problem')), [problem.id]);
    assert.deepEqual(ids(await get('category=warning&level=attention')), [attention.id]);
    assert.deepEqual(ids(await get('category=task')), [task.id]);
    assert.deepEqual(ids(await get('category=other')), [legacy.id], 'a message without a kind is 其他; receipts never show');
    assert.deepEqual(ids(await get('category=warning&q=deploy')), [problem.id], 'combined');
    assert.deepEqual(ids(await get(`category=warning&sender=${a.id}`)), [], 'a member never writes a system message');

    // Time bounds (inclusive) and attachments.
    const at = (m: Message) => encodeURIComponent(m.createdAt);
    assert.deepEqual(ids(await get(`q=deploy&from=${at(fromC)}&to=${at(problem)}`)), [problem.id, fromH.id, fromC.id]);
    assert.deepEqual(ids(await get(`from=${at(fromC)}&to=${at(fromC)}`)), [fromC.id], 'both ends inclusive');
    const offset = encodeURIComponent(new Date(Date.parse(fromC.createdAt)).toISOString().replace('Z', '+00:00'));
    assert.deepEqual(ids(await get(`from=${offset}&to=${offset}`)), [fromC.id], 'an offset time is normalized');
    assert.deepEqual(ids(await get('files=1')), [withFile.id]);

    // A result row: what the page draws.
    const [row] = (await get(`q=build_now`)).items;
    assert.deepEqual(row, { id: fromA.id, from: a.id, createdAt: fromA.createdAt, kind: 'chat', snippet: 'Deploy the 50% build_now please', marks: [[15, 24]] });
    assert.equal((await get('category=task')).items[0].systemKind, 'task');
    assert.equal(filler.length, 300);
  } finally {
    await app.close();
  }
});

test('search: newest-first paging is stable while new messages arrive; the scan cap continues where it stopped', async () => {
  const { app, cluster, a } = await setup();
  try {
    const get = (query: string) => app.api('GET', `/api/clusters/${cluster.id}/messages/search?${query}`);
    const hits = Array.from({ length: 25 }, (_, i) => put(app, cluster.id, a.id, `hit ${i}`)).map((m) => m.id);
    let answer = await get('q=hit&limit=10');
    assert.deepEqual(ids(answer), hits.slice(15).reverse());
    assert.equal(answer.reason, 'limit');
    put(app, cluster.id, a.id, 'hit new');   // arrives between pages: not in the older pages
    const seen = [...ids(answer)];
    while (answer.cursor) {
      answer = await get(`q=hit&limit=10&cursor=${answer.cursor}`);
      seen.push(...ids(answer));
    }
    assert.deepEqual(seen, [...hits].reverse(), 'every hit once, no gap, no duplicate');
    assert.equal(answer.reason, null, 'the oldest end');

    // A rare hit beyond one call's scan: the answer stops at the cap with a cursor, the next call goes on from there.
    const rare = put(app, cluster.id, a.id, 'the needle');
    app.store.transaction(() => { for (let i = 0; i < SEARCH_SCAN_CAP + 10; i++) put(app, cluster.id, 'user', `hay ${i}`); });
    const first = await get('q=needle');
    assert.deepEqual(first.items, []);
    assert.equal(first.reason, 'scan');
    const second = await get(`q=needle&cursor=${first.cursor}`);
    assert.deepEqual(ids(second), [rare.id]);
    // Oldest first from the start: the needle is found before the cap.
    assert.deepEqual(ids(await get('q=needle&order=asc')), [rare.id]);

    // Long messages: the byte budget stops a call after about 4 MiB of text, well before the row cap.
    const deep = put(app, cluster.id, a.id, 'the pin');
    const big = 'w'.repeat(100_000);
    app.store.transaction(() => { for (let i = 0; i < 60; i++) put(app, cluster.id, 'user', big); });
    let answer2 = await get('q=pin');
    let calls = 1;
    assert.equal(answer2.reason, 'scan');
    assert.ok(answer2.items.length === 0);
    while (!answer2.items.length && answer2.cursor) { answer2 = await get(`q=pin&cursor=${answer2.cursor}`); calls++; }
    assert.deepEqual(ids(answer2), [deep.id]);
    assert.equal(calls, 2, '60 × 100 KB: the first call stops after about 42 of them');
  } finally {
    await app.close();
  }
});

test('search: strict validation, auth, other clusters and a trashed cluster', async () => {
  const { app, cluster, a, other } = await setup();
  try {
    const otherMember = app.hub.listMembers(other.id)[0];
    const status = async (query: string, headers: Record<string, string> = bearer(TEST_TOKEN), cid = cluster.id) =>
      (await rawFetch(`${app.url}/api/clusters/${cid}/messages/search?${query}`, { headers })).status;
    for (const bad of [
      'sender=nobody', `sender=${otherMember.id}`, 'category=nope', 'level=problem', 'category=task&level=problem',
      'category=warning&level=high', 'from=2026-01-01', 'from=yesterday', 'to=2026-13-01T00:00:00Z',
      'from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z', 'limit=0', 'limit=x', 'cursor=abc', 'cursor=-1', 'order=up',
      'files=yes', `q=${'x'.repeat(201)}`, 'unknown=1', 'limit=1e2', 'q=a&q=b',
      // Times that do not exist are refused, not rolled over (2026-02-30 is not March 2).
      'from=2026-02-30T00:00:00Z', 'to=2026-04-31T00:00:00Z', 'from=2027-02-29T00:00:00Z', 'from=2026-01-01T24:00:00Z',
      'from=2026-01-01T00:60:00Z', 'from=2026-01-01T00:00:60Z', 'from=2026-01-01T00:00:00%2B15:00', 'from=2026-01-01T00:00:00%2B14:30',
      'from=2026-01-01T00:00:00%2B08:60', 'from=2026-00-10T00:00:00Z',
      // Outside four-figure UTC years once the offset is applied: stored times could not be compared with them.
      'from=0001-01-01T00:00:00%2B14:00', 'to=9999-12-31T23:59:59-14:00', 'from=0000-06-01T00:00:00Z',
      // Control characters: a NUL would cut the LIKE pattern short and match everything.
      'q=%00needle', 'q=a%01b', 'q=a%7Fb', 'q=a%1Bb', 'sender=user%00', `sender=${a.id}%0A`, 'cursor=1%00', 'order=desc%00',
    ]) assert.equal(await status(bad), 400, bad);
    for (const good of ['from=0001-01-01T00:00:00Z', 'to=9999-12-31T23:59:59.999Z', 'from=0001-01-01T00:00:00-14:00', 'from=2028-02-29T00:00:00Z', 'from=2026-01-01T00:00:00-14:00', 'from=2026-12-31T23:59:59.999%2B08:00', 'q=a%09b', 'q=a%0Ab', 'q=a%0D%0Ab']) {
      assert.equal(await status(good), 200, good);
    }
    assert.equal(await status(`sender=${a.id}&limit=1000`), 200, 'a large limit is capped, not refused');
    assert.equal(await status('', {}), 401, 'no token');
    assert.equal(await status('', { ...bearer(TEST_TOKEN), origin: 'https://foreign.example' }), 403, 'a foreign page');
    assert.equal(await status('', bearer(TEST_TOKEN), 'no-such-cluster'), 404);
    put(app, other.id, otherMember.id, 'secret');
    assert.deepEqual(ids(await app.api('GET', `/api/clusters/${cluster.id}/messages/search?q=secret`)), []);
    app.hub.deleteCluster(other.id);
    assert.equal(await status('q=secret', bearer(TEST_TOKEN), other.id), 404, 'a trashed cluster is not searched');
  } finally {
    await app.close();
  }
});

/** The snippet with its marks drawn as [..]. */
const drawn = ({ snippet, marks }: { snippet: string; marks: [number, number][] }) =>
  marks.reduceRight((text, [s, e]) => `${text.slice(0, s)}[${text.slice(s, e)}]${text.slice(e)}`, snippet);
const normal = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/[A-Z]/g, (c) => c.toLowerCase());

test('search: the snippet is one line around the first hit, cut with …, its hits marked where they really are', () => {
  assert.deepEqual(searchSnippet('short\n\nbody', 'x'), { snippet: 'short body', marks: [] });
  const long = `${'a'.repeat(300)}NEEDLE${'b'.repeat(300)}`;
  const s = searchSnippet(long, 'needle');
  assert.match(s.snippet, /^…a{40}NEEDLEb+…$/);
  assert.deepEqual(s.marks, [[41, 47]]);
  assert.ok(s.snippet.length <= 142);
  assert.match(drawn(searchSnippet(`${'a'.repeat(300)}end`, 'END')), /^….*a\[end\]$/, 'near the end: the last characters, still the full width');
  assert.deepEqual(searchSnippet('x'.repeat(200), undefined).marks, []);
  assert.equal(searchSnippet('x'.repeat(200), undefined).snippet.length, 141, 'no keyword: the start');
  // A hit across a line break: marked where the query matched the original text, not at a look-alike earlier on.
  const twice = searchSnippet(`alpha beta ${'x'.repeat(200)} alpha\nbeta tail`, 'alpha\nbeta');
  assert.match(drawn(twice), /x \[alpha beta\] tail$/);
  assert.equal(twice.marks.length, 1);
  // Every hit in the line is marked; collapsing whitespace moves them, the index map keeps them on the right letters.
  assert.equal(drawn(searchSnippet('Go  go\n\ngo', 'go')), '[Go] [go] [go]');
  // A hit longer than the line: marked up to the cut, starting a little before it.
  const huge = 'q'.repeat(400);
  const cut = searchSnippet(`start ${huge} end`, huge);
  assert.ok(cut.snippet.endsWith('…') && cut.marks[0][1] === cut.snippet.length - 1, 'the mark runs to the cut');
  assert.ok(cut.snippet.startsWith('start'));
  // Cut points never split a grapheme: a family emoji (one grapheme, 8 code units) at the start cut is kept whole.
  const family = '👨‍👩‍👧';
  assert.ok(searchSnippet(`${family}${'a'.repeat(39)}${'b'.repeat(200)}`, 'b').snippet.startsWith(family));
  assert.ok(!/^…[\uDC00-\uDFFF‍]/.test(searchSnippet(`a😀${'a'.repeat(38)}${'b'.repeat(200)}`, 'b').snippet), 'no half emoji');
});

test('search: property: the marked text, normalised, is the query, normalised (or its start when the line cuts it)', () => {
  let seed = 7;
  const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const plain = ['a', 'B', 'b', ' ', '  ', '\n', '\t', 'é', 'É', '中', '%', '_', 'x'];
  // Characters no ANCHOR is: emoji, flags, ZWJ sequences, combining and skin-tone sequences, often in long runs.
  const clusters = ['😀', '🙂', '🎯', '🇨🇳', '🇫🇷', '👨‍👩‍👧', 'é', '👍🏽', '́'];
  const token = () => (random(3) ? plain[random(plain.length)] : clusters[random(clusters.length)].repeat(random(4) ? 1 + random(3) : 1 + random(350)));
  const swapAscii = (s: string) => s.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  let checked = 0;
  for (let round = 0; round < 4000; round++) {
    const parts = Array.from({ length: 1 + random(60) }, token);
    let q = '';
    if (round % 3 === 0) {
      // The query is a cluster sequence of its own, put at the very start, the very end or anywhere.
      q = clusters[random(clusters.length)].repeat(1 + random(2));
      const where = random(3);
      parts.splice(where === 0 ? 0 : where === 1 ? parts.length : random(parts.length + 1), 0, q);
    }
    const body = parts.join('');
    if (round % 3 !== 0) {
      const points = Array.from(body);   // code points: a query never starts or ends inside a surrogate pair
      const from = random(points.length), to = from + 1 + random(Math.min(200, points.length - from));
      q = points.slice(from, to).join('');
      if (round % 2) q = swapAscii(q);   // A–Z fold both ways, as the SQL does
    }
    if (!q.trim()) continue;
    // Both as the whole body and as the excerpt SQL would cut (code points: 200 before the first hit, 600 + q's length).
    const hitAt = Array.from(body.slice(0, lower(body).indexOf(lower(q)))).length;
    const points = Array.from(body);
    const from = Math.max(0, hitAt - 200), length = 600 + q.length;
    const excerpt = points.slice(from, from + length).join('');
    for (const [text, cut] of [[body, { before: false, after: false }], [excerpt, { before: from > 0, after: from + length < points.length }]] as const) {
      const s = searchSnippet(text, q, cut);
      const where = `${JSON.stringify(q)} in ${JSON.stringify(text.slice(0, 80))}… (${text.length}), cut ${JSON.stringify(cut)}: ${JSON.stringify(s)}`;
      assert.ok(s.marks.length >= 1, `a mark for ${where}`);
      const marked = normal(s.snippet.slice(s.marks[0][0], s.marks[0][1]));
      const want = normal(q);
      assert.ok(marked.length > 0 && want.startsWith(marked), `the start of the hit for ${where}`);
      if (marked !== want) assert.ok(s.snippet.endsWith('…') && s.marks[0][1] === s.snippet.length - 1, `only a cut hit is shorter: ${where}`);
    }
    checked++;
  }
  assert.ok(checked > 3000, `checked ${checked}`);
});

test('search: the byte budget counts each row’s own text; only a first row may pass it; continuations skip and repeat nothing', async () => {
  const { app, cluster } = await setup();
  try {
    const page = (cursor?: number, scanBytes = 10) => app.store.searchMessages(cluster.id, {}, { cursor, order: 'desc', limit: 30, scanCap: 5000, scanBytes });
    const nine = put(app, cluster.id, 'user', 'ninebytes');   // older
    const two = put(app, cluster.id, 'user', 'ab');           // newer: scanned first
    let answer = page();
    assert.deepEqual(answer.hits.map((h) => h.id), [two.id], 'the 9-byte row would cross the 10-byte budget: left to the next call');
    assert.equal(answer.next?.reason, 'scan');
    answer = page(answer.next!.rowid);
    assert.deepEqual(answer.hits.map((h) => h.id), [nine.id]);
    // A first row larger than the budget still comes back alone.
    const big = put(app, cluster.id, 'user', 'x'.repeat(20));
    assert.deepEqual(page().hits.map((h) => h.id), [big.id]);
    // Walking everything with a small budget: each row once, in order.
    const sizes = [1, 7, 3, 12, 4, 4, 2, 30, 5, 5, 5];
    const ids = sizes.map((n, i) => put(app, cluster.id, 'user', String(i % 10).repeat(n)).id);
    const all = [...ids].reverse().concat([big.id, two.id, nine.id]);
    const seen: string[] = [];
    let cursor: number | undefined;
    for (let calls = 0; calls < 50; calls++) {
      const a = page(cursor);
      seen.push(...a.hits.map((h) => h.id));
      if (!a.next) break;
      cursor = a.next.rowid;
    }
    assert.deepEqual(seen, all);
  } finally {
    await app.close();
  }
});

test('search: a hit far into a long message comes back as an excerpt cut in SQL, its snippet and marks right', async () => {
  const { app, cluster, a } = await setup();
  try {
    const body = `${'log line, nothing here. '.repeat(20_000)}the Needle is HERE${' and more text'.repeat(20_000)}`;
    const m = put(app, cluster.id, a.id, body);
    const [hit] = app.store.searchMessages(cluster.id, { q: 'needle is here' }, { order: 'desc', limit: 30, scanCap: 5000, scanBytes: 4 << 20 }).hits;
    assert.equal(hit.id, m.id);
    assert.ok(hit.excerpt.length < 1000 && hit.cutBefore && hit.cutAfter, 'only an excerpt reaches JS');
    assert.equal('body' in hit, false);
    const [row] = (await app.api('GET', `/api/clusters/${cluster.id}/messages/search?q=${encodeURIComponent('needle is here')}`)).items;
    assert.match(drawn(row), /^….*nothing here\. the \[Needle is HERE\] and more text.*…$/);
    // The start of a long message, without a keyword: its first line only.
    const [first] = (await app.api('GET', `/api/clusters/${cluster.id}/messages/search?sender=${a.id}`)).items;
    assert.ok(first.snippet.startsWith('log line, nothing here.') && first.snippet.endsWith('…') && first.snippet.length <= 142);
  } finally {
    await app.close();
  }
});

test('search: a hit with no plain character before it in the excerpt is still in the line, marked', async () => {
  // The reviewer's case: the excerpt starts inside 350 emoji, the first plain character comes after the hit.
  const direct = searchSnippet(`${'🙂'.repeat(200)}🎯 suffix`, '🎯', { before: true, after: false });
  assert.ok(direct.marks.length === 1 && direct.snippet.slice(direct.marks[0][0], direct.marks[0][1]) === '🎯', JSON.stringify(direct));
  // A hit inside one huge grapheme (the target and 700 combining marks), cut off after: no boundary follows the hit.
  const huge = searchSnippet(`ab🎯${'́'.repeat(700)}`, '🎯', { before: false, after: true });
  assert.ok(huge.marks.length === 1 && huge.snippet.slice(huge.marks[0][0], huge.marks[0][1]) === '🎯', JSON.stringify(huge));
  const { app, cluster, a } = await setup();
  try {
    put(app, cluster.id, a.id, `${'🙂'.repeat(350)}🎯 suffix`);
    const [row] = searchClusterMessages(app.store, cluster.id, new URLSearchParams({ q: '🎯' }))!.items;
    assert.ok(row.marks.length === 1 && row.snippet.slice(row.marks[0][0], row.marks[0][1]) === '🎯' && row.snippet.endsWith('🎯 suffix'), JSON.stringify(row));
  } finally {
    await app.close();
  }
});

test('search: cut points keep flags, ZWJ sequences, combining marks and skin tones whole, at both ends', () => {
  const sequences = { flag: '🇨🇳', family: '👨‍👩‍👧', combining: 'é', skin: '👍🏽' };
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [name, seq] of Object.entries(sequences)) {
    const run = `(?:${escape(seq)})*`;
    // The end cut inside a long run after the hit (the reviewer's 'xx' + flags).
    const tail = searchSnippet(`xx${seq.repeat(100)}`, 'xx').snippet;
    assert.match(tail, new RegExp(`^xx${run}…$`, 'u'), `${name} at the end cut: ${tail}`);
    // The start cut inside a long run before the hit, with the body starting at the excerpt (segmented from 0).
    const head = searchSnippet(`${seq.repeat(100)}zz tail`, 'zz').snippet;
    assert.match(head, new RegExp(`^…${run}zz tail$`, 'u'), `${name} at the start cut: ${head}`);
    // Odd offsets: one, then two plain characters before the run, so a naive cut would land inside a sequence.
    for (const lead of ['a', 'ab']) {
      const both = searchSnippet(`${lead}${seq.repeat(60)}zz${seq.repeat(80)}`, 'zz').snippet;
      assert.match(both, new RegExp(`^…?(?:${lead})?${run}zz${run}…$`, 'u'), `${name} after ${lead}: ${both}`);
    }
    // An excerpt that SQL cut inside the run: pairing before the first plain character is unknown, so it starts there.
    const cut = searchSnippet(`${seq.repeat(100)} zz${' tail'.repeat(60)}`, 'zz', { before: true, after: true }).snippet;
    assert.ok(cut.replace(new RegExp(`^…${run}`, 'u'), '').startsWith(' zz tail') && cut.endsWith('…'), `${name} after an SQL cut: ${cut}`);
  }
});
