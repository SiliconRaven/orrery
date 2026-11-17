// 标为已知 for the header's delivery problems (docs/architecture.md「网页的数据流」), and offline problems that clear
// themselves once the member read the message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/core/store.ts';
import { REPO_ROOT } from '../src/main.ts';
import { insertMessageWithEvent, startTestHub, tempDir, type TestHub } from './helpers.ts';

/** A paused Hub (nothing is delivered) with one cluster of two mock members. */
async function setup() {
  const app = await startTestHub();
  app.hub.setPaused(true);
  const { cluster, members } = await app.cluster('problems', ['a', 'b']);
  return { app, cluster, members };
}

/** One message from the user to `to`; returns its id and its deliveries in `to`'s order. */
function send(app: TestHub, clusterId: string, to: string[]) {
  const id = randomUUID();
  const { deliveries } = insertMessageWithEvent(app.store, { id, clusterId, from: 'user', mentions: to, body: `hello ${id.slice(0, 4)}`,
    replyTo: null, chainId: id, hop: 0, createdAt: new Date().toISOString() }, to);
  return { id, deliveries };
}

const problems = (app: TestHub, clusterId: string) => app.api('GET', `/api/clusters/${clusterId}/delivery-problems`);
const dismissOne = (app: TestHub, clusterId: string, deliveryId: string, body: unknown = {}) =>
  app.api('POST', `/api/clusters/${clusterId}/deliveries/${deliveryId}/dismiss`, body);
const dismissAll = (app: TestHub, clusterId: string, body: unknown) => app.api('POST', `/api/clusters/${clusterId}/delivery-problems/dismiss`, body);
const dismissedEvents = (app: TestHub) => app.events.filter((e) => e.kind === 'delivery_dismissed');

test('标为已知: one, then all the page listed; each write is one event; repeating changes nothing; other clusters keep theirs', async () => {
  const { app, cluster, members: [a, b] } = await setup();
  try {
    const other = await app.cluster('other', ['c']);
    const [o] = send(app, other.cluster.id, [other.members[0].id]).deliveries;
    app.store.setDeliveryState(o.id, 'failed', 'boom');
    const first = send(app, cluster.id, [a.id, b.id]);
    app.store.setDeliveryState(first.deliveries[0].id, 'failed', 'boom');
    app.store.setDeliveryState(first.deliveries[1].id, 'offline', 'gone');
    const [unknown] = send(app, cluster.id, [a.id]).deliveries;
    app.store.setDeliveryState(unknown.id, 'done', null, 'unknown');
    assert.equal((await problems(app, cluster.id)).count, 3);

    assert.deepEqual(await dismissOne(app, cluster.id, first.deliveries[0].id), { dismissed: 1, count: 2 });
    assert.deepEqual(dismissedEvents(app).map((e) => [e.clusterId, e.memberId, (e.payload as any).deliveryIds]), [[cluster.id, null, [first.deliveries[0].id]]]);
    assert.deepEqual(await dismissOne(app, cluster.id, first.deliveries[0].id), { dismissed: 0, count: 2 }, 'a retry is fine');
    assert.equal(dismissedEvents(app).length, 1, 'and records nothing');
    const listed = await problems(app, cluster.id);
    assert.deepEqual(listed.items.map((r: any) => r.delivery.id), [unknown.id, first.deliveries[1].id]);

    assert.deepEqual(await dismissAll(app, cluster.id, { version: listed.version }), { dismissed: 2, count: 0 });
    assert.deepEqual(new Set((dismissedEvents(app)[1].payload as any).deliveryIds), new Set([unknown.id, first.deliveries[1].id]));
    assert.deepEqual(await dismissAll(app, cluster.id, { version: listed.version }), { dismissed: 0, count: 0 }, 'idempotent');
    assert.equal(dismissedEvents(app).length, 2);
    const after = await problems(app, cluster.id);
    assert.deepEqual([after.count, after.items], [0, []]);
    assert.equal((await problems(app, other.cluster.id)).count, 1, 'another cluster is untouched');

    // Nothing else of the delivery changed: same state, error and outcome in the message's receipts.
    const receipts = (await app.api('GET', `/api/clusters/${cluster.id}/messages/${first.id}`)).deliveries;
    assert.deepEqual(receipts.map((d: any) => [d.state, d.error, d.outcome]), [['failed', 'boom', null], ['offline', 'gone', null]]);
  } finally {
    await app.close();
  }
});

test('标为已知 for all leaves a problem that appeared after the listing, even with the clock frozen in one millisecond', async () => {
  const { app, cluster, members: [a] } = await setup();
  try {
    const frozen = '2026-01-01T00:00:00.000Z';
    const freeze = () => app.store.db.prepare('UPDATE deliveries SET updated_at = ?').run(frozen);   // every row: the same millisecond
    const [old] = send(app, cluster.id, [a.id]).deliveries;
    app.store.setDeliveryState(old.id, 'offline', 'gone');
    const [queued] = send(app, cluster.id, [a.id]).deliveries;   // not a problem yet when listed
    freeze();
    const listed = await problems(app, cluster.id);
    assert.deepEqual(listed.items.map((r: any) => r.delivery.id), [old.id]);
    app.store.setDeliveryState(queued.id, 'failed', 'boom');   // an old row that turns into a problem after the listing
    const [fresh] = send(app, cluster.id, [a.id]).deliveries;   // and a new one
    app.store.setDeliveryState(fresh.id, 'offline', 'gone');
    freeze();
    assert.deepEqual(await dismissAll(app, cluster.id, { version: listed.version }), { dismissed: 1, count: 2 });
    assert.deepEqual((await problems(app, cluster.id)).items.map((r: any) => r.delivery.id).sort(), [queued.id, fresh.id].sort());
  } finally {
    await app.close();
  }
});

test('state_seq: the triggers number every insert and every state or outcome change, whoever writes it', () => {
  const store = new Store(join(tempDir(), 'seq.db'));
  try {
    store.insertCluster({ id: 'c', name: 'c', createdAt: '2026-01-01T00:00:00.000Z', category: '' }, [
      { id: 'm1', clusterId: 'c', name: 'One', avatar: null, harness: 'mock', model: null, workerSessionId: 'w1', cwd: '/p', origin: 'created', mode: 'native', effort: null, removedAt: null },
    ]);
    const seq = (id: string) => Number((store.db.prepare('SELECT state_seq FROM deliveries WHERE id = ?').get(id) as any).state_seq);
    const msg = (id: string) => ({ id, clusterId: 'c', from: 'user', mentions: ['m1'], body: id, replyTo: null, chainId: id, hop: 0, createdAt: '2026-01-01T00:00:01.000Z' });
    const [d1] = store.insertMessage(msg('a'), ['m1']);
    const [d2] = store.insertMessage(msg('b'), ['m1']);
    assert.ok(seq(d1.id) > 0 && seq(d2.id) > seq(d1.id), 'inserts are numbered in order');
    const before = seq(d2.id);
    store.db.prepare("UPDATE deliveries SET state = 'failed' WHERE id = ?").run(d1.id);   // a raw write that sets no time at all
    assert.ok(seq(d1.id) > before, 'a state change gets the next number');
    const afterState = seq(d1.id);
    store.db.prepare("UPDATE deliveries SET outcome = 'unknown' WHERE id = ?").run(d1.id);
    assert.ok(seq(d1.id) > afterState, 'so does an outcome change');
    const now = seq(d1.id);
    store.db.prepare("UPDATE deliveries SET error = 'x', updated_at = 'later', dismissed_at = 'y', state = 'failed' WHERE id = ?").run(d1.id);
    assert.equal(seq(d1.id), now, 'other columns, and a state set to what it was, do not');
    const listing = store.deliveryProblems('c', 100);
    assert.equal(listing.version, now);
    store.db.prepare('DELETE FROM deliveries WHERE id = ?').run(d1.id); // the largest sequence can be purged
    store.setDeliveryState(d2.id, 'failed', 'failed after the listing');
    assert.ok(seq(d2.id) > listing.version);
    assert.deepEqual(store.dismissDeliveryProblems('c', listing.version, '2026-01-01T00:00:02.000Z'), []);
  } finally { store.close(); }
});

test('标为已知 errors: unknown cluster or delivery, another cluster, not a problem, bad bodies', async () => {
  const { app, cluster, members: [a, b] } = await setup();
  try {
    const other = await app.cluster('other', ['c']);
    const [elsewhere] = send(app, other.cluster.id, [other.members[0].id]).deliveries;
    app.store.setDeliveryState(elsewhere.id, 'failed', 'boom');
    const [fine] = send(app, cluster.id, [a.id]).deliveries;
    app.store.setDeliveryState(fine.id, 'done');
    const handed = send(app, cluster.id, [a.id]);
    app.store.setDeliveryState(handed.deliveries[0].id, 'failed', 'boom');
    await app.api('POST', `/api/clusters/${cluster.id}/deliveries/${handed.deliveries[0].id}/handoff`, { targetMemberId: b.id, confirmStopped: true });
    const [problem] = send(app, cluster.id, [a.id]).deliveries;
    app.store.setDeliveryState(problem.id, 'offline', 'gone');
    const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, re);
    await rejects(dismissOne(app, randomUUID(), problem.id), /400 .*unknown cluster/);
    await rejects(dismissOne(app, cluster.id, randomUUID()), /400 .*unknown delivery in this cluster/);
    await rejects(dismissOne(app, cluster.id, elsewhere.id), /400 .*unknown delivery in this cluster/);
    await rejects(dismissOne(app, cluster.id, fine.id), /400 .*not a delivery problem/);
    await rejects(dismissOne(app, cluster.id, handed.deliveries[0].id), /400 .*not a delivery problem/);   // handed off already
    await rejects(dismissOne(app, cluster.id, problem.id, { all: true }), /400 .*body must be \{\}/);
    await rejects(dismissAll(app, randomUUID(), { version: 1 }), /400 .*unknown cluster/);
    await rejects(dismissAll(app, cluster.id, {}), /400 .*version/);
    for (const version of ['1', -1, 1.5, null]) await rejects(dismissAll(app, cluster.id, { version }), /400 .*version/);
    await rejects(dismissAll(app, cluster.id, { version: 1, extra: 1 }), /400 .*version/);
    await rejects(dismissAll(app, cluster.id, { before: new Date().toISOString() }), /400 .*version/);   // the old wall-clock bound is gone
    assert.equal(dismissedEvents(app).length, 0);
    assert.equal((await problems(app, cluster.id)).count, 1);
    assert.equal((await problems(app, other.cluster.id)).count, 1);
  } finally {
    await app.close();
  }
});

test('a delivery marked known can still be handed off and resent', async () => {
  const { app, cluster, members: [a, b] } = await setup();
  try {
    const one = send(app, cluster.id, [a.id]).deliveries[0];
    const two = send(app, cluster.id, [a.id]).deliveries[0];
    for (const d of [one, two]) app.store.setDeliveryState(d.id, 'offline', 'gone');
    const { version } = await problems(app, cluster.id);
    await dismissAll(app, cluster.id, { version });
    const handoff = await app.api('POST', `/api/clusters/${cluster.id}/deliveries/${one.id}/handoff`, { targetMemberId: b.id });
    assert.ok(handoff.sourceDelivery.handoffMessageId);
    const resend = await app.api('POST', `/api/clusters/${cluster.id}/deliveries/${two.id}/resend`, {});
    assert.deepEqual(resend.message.mentions, [a.id]);
    assert.equal((await problems(app, cluster.id)).count, 0);
  } finally {
    await app.close();
  }
});

test('the mark survives reopening the database', () => {
  const path = join(tempDir(), 'dismiss.db');
  const store = new Store(path);
  store.insertCluster({ id: 'c', name: 'c', createdAt: '2026-01-01T00:00:00.000Z', category: '' }, [
    { id: 'm1', clusterId: 'c', name: 'One', avatar: null, harness: 'mock', model: null, workerSessionId: 'w1', cwd: '/p', origin: 'created', mode: 'native', effort: null, removedAt: null },
  ]);
  const [d] = store.insertMessage({ id: 'msg1', clusterId: 'c', from: 'user', mentions: ['m1'], body: 'hi', replyTo: null, chainId: 'msg1', hop: 0, createdAt: '2026-01-01T00:00:01.000Z' }, ['m1']);
  store.setDeliveryState(d.id, 'failed', 'boom');
  assert.equal(store.dismissDeliveryProblem('c', d.id, '2026-01-02T00:00:00.000Z'), true);
  store.close();
  const reopened = new Store(path);
  try {
    assert.equal(reopened.deliveryProblems('c', 10).count, 0);
    assert.equal(reopened.dismissDeliveryProblem('c', d.id, '2026-01-03T00:00:00.000Z'), false, 'already marked; the first time is kept');
    assert.equal((reopened.db.prepare('SELECT dismissed_at FROM deliveries WHERE id = ?').get(d.id) as any).dismissed_at, '2026-01-02T00:00:00.000Z');
  } finally { reopened.close(); }
});

test('an offline delivery stops counting once its member read the message; a skip, a failure or an unknown outcome does not clear', async () => {
  const { app, cluster, members: [a, b] } = await setup();
  try {
    const read = send(app, cluster.id, [a.id]);
    app.store.setDeliveryState(read.deliveries[0].id, 'offline', 'gone');
    const skipped = send(app, cluster.id, [b.id]);
    app.store.setDeliveryState(skipped.deliveries[0].id, 'offline', 'gone');
    const failed = send(app, cluster.id, [a.id]);
    app.store.setDeliveryState(failed.deliveries[0].id, 'failed', 'boom');
    const unknown = send(app, cluster.id, [a.id]);
    app.store.setDeliveryState(unknown.deliveries[0].id, 'done', null, 'unknown');
    assert.equal((await problems(app, cluster.id)).count, 4);

    app.hub.readMessages(a.id, { history: true });   // a reads all four
    app.hub.skipMessages(app.store.getMember(b.id)!, [skipped.id]);
    assert.ok(app.events.some((e) => e.kind === 'read' && e.memberId === a.id), 'the page hears of the read');
    const left = await problems(app, cluster.id);
    assert.deepEqual(left.items.map((r: any) => r.delivery.id).sort(), [skipped, failed, unknown].map((m) => m.deliveries[0].id).sort());
    await assert.rejects(dismissOne(app, cluster.id, read.deliveries[0].id), /not a delivery problem/, 'cleared: nothing to mark');
  } finally {
    await app.close();
  }
});

test('the auto-clear rule holds for a removed member that read before it left, and for a hidden member', async () => {
  const { app, cluster, members: [a, b] } = await setup();
  try {
    const toA = send(app, cluster.id, [a.id]);
    const toB = send(app, cluster.id, [b.id]);
    const notRead = send(app, cluster.id, [b.id]);
    for (const m of [toA, toB, notRead]) app.store.setDeliveryState(m.deliveries[0].id, 'offline', 'gone');
    app.hub.readMessages(a.id, { history: true });
    await app.api('POST', `/api/members/${b.id}/hidden`, { hidden: true });
    app.store.markRead(b.id, [toB.id], 'read_messages');
    await app.api('DELETE', `/api/clusters/${cluster.id}/members/${a.id}`);
    assert.deepEqual((await problems(app, cluster.id)).items.map((r: any) => r.delivery.id), [notRead.deliveries[0].id],
      'read before removal or while hidden: cleared; unread: still a problem');
  } finally {
    await app.close();
  }
});

test('skipped first: still a problem; a later history read or an acknowledgement clears it, with a read event, and the receipt keeps its skip', async () => {
  const { app, cluster, members: [a, b] } = await setup();
  try {
    const later = send(app, cluster.id, [a.id]);
    const acked = send(app, cluster.id, [b.id]);
    const only = send(app, cluster.id, [b.id]);
    for (const m of [later, acked, only]) app.store.setDeliveryState(m.deliveries[0].id, 'offline', 'gone');
    app.hub.skipMessages(app.store.getMember(a.id)!, [later.id]);
    app.hub.skipMessages(app.store.getMember(b.id)!, [acked.id, only.id]);
    assert.equal((await problems(app, cluster.id)).count, 3, 'a skip is not a read');

    const seen = app.events.length;
    assert.ok(app.hub.readMessages(a.id, { history: true }).some((m) => m.id === later.id), 'the history read returns it');
    app.hub.ackMessages(b.id, [acked.id]);
    const reads = app.events.slice(seen).filter((e) => e.kind === 'read');
    assert.deepEqual(reads.map((e) => [e.memberId, (e.payload as any).messageIds.includes(e.memberId === a.id ? later.id : acked.id)]), [[a.id, true], [b.id, true]],
      'each tells the page, so it reads the count again');
    assert.deepEqual((await problems(app, cluster.id)).items.map((r: any) => r.delivery.id), [only.deliveries[0].id], 'skip only: still a problem');

    // The first way of reading stays what every other reader shows (receipts, participation, unread).
    const receipt = (await app.api('GET', `/api/clusters/${cluster.id}/messages/${later.id}`)).reads.find((r: any) => r.memberId === a.id);
    assert.equal(receipt.via, 'skip');
    assert.deepEqual(app.store.markRead(a.id, [later.id], 'read_messages'), [], 'reading it again changes nothing more');
  } finally {
    await app.close();
  }
});

// ---- the page (src/web/public): the dialog's text and the writes it sends ----

const ui = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'ui.js')).href);
const appJs = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');

test('page: the dialog says how entries go away, how many are listed, and when empty', () => {
  assert.match(ui.problemsDescription(3, 3), /交接、重发或标为已知后，它不再列出；离线的投递在那个成员自己读到这条消息后也会消失。$/);
  assert.match(ui.problemsDescription(150, 100), /这里列出最新的 100 条。$/);
  assert.equal(ui.problemsDescription(0, 0), '没有需要处理的投递了。');
});

test('page: 全部标为已知 asks only for more than five, naming the count and the ones beyond the list', () => {
  assert.equal(ui.dismissAllConfirmation(5, 5), null);
  const ask = ui.dismissAllConfirmation(6, 6);
  assert.match(ask.message, /^会把 6 条有问题的投递标为已知，/);
  assert.equal(ask.confirmText, '全部标为已知');
  assert.match(ui.dismissAllConfirmation(130, 100).message, /^会把 130 条有问题的投递标为已知（包括列表外较早的 30 条）/);
});

test('page: the 全部标为已知 request is fixed when taken; a later listing does not change it', () => {
  const listing = { count: 7, items: Array.from({ length: 7 }, (_, i) => ({ id: i })), version: 41 };
  const request = ui.dismissAllRequest(listing);
  assert.deepEqual(request.body, { version: 41 });
  assert.match(request.ask.message, /^会把 7 条/);
  Object.assign(listing, { count: 8, version: 57 });   // what a refresh under the question would bring
  listing.items.push({ id: 7 });
  assert.deepEqual(request.body, { version: 41 }, 'still the confirmed listing');
  assert.match(request.ask.message, /^会把 7 条/);
  assert.equal(ui.dismissAllRequest({ count: 2, items: [{}, {}], version: 3 }).ask, null, 'few: no question');
});

test('page: the two writes, the bound of "all", and the events that reload the count', () => {
  // "all" takes its request from the listing before asking and sends exactly that; the one-at-a-time guard keeps any
  // other write (which is what replaces `data`) from running between the question and the send.
  assert.match(appJs, /dismissAll\.addEventListener\('click', \(\) => exclusive\(async \(\) => \{\n.*\n    const request = dismissAllRequest\(data\);\n    if \(request\.ask && !await confirmDialog\(request\.ask\)\) return;\n    await write\(`\$\{path\}\/dismiss`, request\.body, 0\);/);
  assert.match(appJs, /const exclusive = async \(action\) => \{\n    if \(busy\) return;\n    busy = true;\n    try \{ await action\(\); \} finally \{ busy = false; \}/);
  assert.match(appJs, /onclick: \(\) => exclusive\(\(\) => write\(`\/api\/clusters\/\$\{encodeURIComponent\(cid\)\}\/deliveries\/\$\{encodeURIComponent\(delivery\.id\)\}\/dismiss`, \{\}, i\)\)/, 'one');
  assert.match(appJs, /data = await api\('GET', path\);/);
  assert.equal(appJs.match(/data = await api\('GET', path\);/g)!.length, 2, 'data is replaced only on open and inside write');
  assert.match(appJs, /'aria-label': `标为已知：\$\{nameOf\(delivery\.memberId\)\} 的「\$\{snippet\(msg\.body, 30\)\}」`/, 'names the member and the message');
  assert.match(appJs, /case 'delivery_dismissed':.*\n      if \(e\.clusterId === S\.sel\.cluster\) loadProblemsSoon\(\);/);
  assert.match(appJs, /the problem count \(Store\.deliveryProblems\)\.\n      if \(e\.clusterId === S\.sel\.cluster\) loadProblemsSoon\(\);\n      break;\n    case 'delivery_dismissed'/,
    'a member reading may clear an offline problem');
});
