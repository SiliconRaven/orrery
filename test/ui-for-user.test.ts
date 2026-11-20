// 给你的消息 (docs/collaboration.md「给你的消息」): which member messages the chat marks for the user, which of them are
// still unread against the read position (in the loaded window and in the pages before it), and the order the button jumps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { insertMessageWithEvent, startTestHub, TEST_TOKEN, type TestHub } from './helpers.ts';

const ui = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'ui.js')).href);

const msg = (id: string, from: string, body = 'hi', extra: Record<string, unknown> = {}) => ({ id, clusterId: 'c', from, body, mentions: [], ...extra });

test('for user: a member message @-mentioning no member, or writing @user, counts; nothing else does', () => {
  assert.equal(ui.forUser(msg('1', 'm1')), true, 'a member message with no @ only stays in the record');
  assert.equal(ui.forUser(msg('2', 'm1', '@user 做完了', { mentions: [] })), true, 'a member writes @user');
  assert.equal(ui.forUser(msg('3', 'm1', '@user 和 @B 看一下', { mentions: ['m2'] })), true, '@user next to a member still counts');
  assert.equal(ui.forUser(msg('4', 'm1', '@B 看一下', { mentions: ['m2'] })), false, 'only a member is @-mentioned');
  assert.equal(ui.forUser(msg('5', 'm1', '@all 看一下', { mentions: ['m2', 'm3'], explicitMentions: [] })), false, '@all is for the members');
  assert.equal(ui.forUser(msg('6', 'm1', '@all 看一下', { mentions: [], explicitMentions: [] })), false, 'also when nobody else is in the group');
  assert.equal(ui.forUser(msg('7', 'm1', '交给 B', { mentions: ['m2'] })), false, 'sent with `to`: addressed to a member');
  assert.equal(ui.forUser(msg('8', 'user')), false, "the user's own message");
  assert.equal(ui.forUser(msg('9', 'system', '任务已创建', { kind: 'system' })), false, 'a system or task notice');
  assert.equal(ui.forUser(msg('10', 'plugin:p', 'x', { kind: 'plugin' })), false, "a plugin's message");
  assert.equal(ui.forUser(msg('11', 'm1', '#3 已提交', { kind: 'task_comment' })), true, "a member's task comment @-mentioning nobody");
  assert.equal(ui.forUser(null), false);
});

test('for user: @user is read the way the Hub reads a written @', () => {
  for (const body of ['@user', '好了 @user', '@user，好了', '@user.', '（@user）']) assert.equal(ui.writesAtUser(body), true, body);
  for (const body of ['`@user`', '```\n@user\n```', '"@user"', '“@user”', 'mail me@user.example.com', '@username', '@user2', '@User', '没有'])
    assert.equal(ui.writesAtUser(body), false, body);
  assert.equal(ui.writesAtUser('`@user` 之后 @user'), true, 'a second, unquoted one counts');
  // So a member message whose only @user is quoted, and that @-mentions a member, is not for the user.
  assert.equal(ui.forUser(msg('q', 'm1', '`@user` 是什么 @B', { mentions: ['m2'] })), false);
});

test('for user: in the newest window, unread is after the read position, or every one when the position is older', () => {
  const window = [msg('a', 'm1'), msg('b', 'user'), msg('c', 'm1', '@B', { mentions: ['m2'] }), msg('d', 'm2'), msg('e', 'system', 'x', { kind: 'system' }), msg('f', 'm1', '@user')];
  assert.deepEqual(ui.unreadForUser(window, null), ['a', 'd', 'f'], 'never read: every one');
  assert.deepEqual(ui.unreadForUser(window, 'a'), ['d', 'f'], 'the read message itself is read');
  assert.deepEqual(ui.unreadForUser(window, 'd'), ['f']);
  assert.deepEqual(ui.unreadForUser(window, 'f'), [], 'read to the newest: none');
  assert.deepEqual(ui.unreadForUser(window, 'older'), ['a', 'd', 'f'], 'the newest window: the position is older than all of it');
  assert.deepEqual(ui.unreadForUser([], 'x'), []);
});

test('for user: a scan page ends at the read position, at the first message, or at the page limit', () => {
  const page = [msg('p1', 'm1'), msg('p2', 'user'), msg('p3', 'm1', '@user')];
  const opts = { pageSize: 3, pages: 1, maxPages: 3 };
  assert.deepEqual(ui.forUserScanPage(page, null, opts), { ids: ['p1', 'p3'], next: 'p1', partial: false }, 'a full page: read on before its oldest');
  assert.deepEqual(ui.forUserScanPage(page, 'p1', opts), { ids: ['p3'], next: null, partial: false }, 'the read position is in it');
  assert.deepEqual(ui.forUserScanPage(page, null, { ...opts, pageSize: 4 }), { ids: ['p1', 'p3'], next: null, partial: false }, 'a short page: the first message');
  assert.deepEqual(ui.forUserScanPage([], 'r', opts), { ids: [], next: null, partial: false });
  assert.deepEqual(ui.forUserScanPage(page, 'r', { ...opts, pages: 3 }), { ids: ['p1', 'p3'], next: 'p1', partial: true }, 'the limit keeps the next page for continuation');
});

test('for user: older pages go in front; a newest window keeps what is older than it and puts its own in order', () => {
  assert.deepEqual(ui.mergeForUser(['w1'], ['o1', 'o2']), ['o1', 'o2', 'w1']);
  assert.deepEqual(ui.mergeForUser(['o2', 'w1'], ['o1', 'o2']), ['o1', 'o2', 'w1'], 'no id twice');
  // The window trimmed its first page (o1 left it) and got a new message w2.
  assert.deepEqual(ui.mergeForUser(['o1', 'w1'], ['w1', 'w2'], new Set(['x', 'w1', 'w2'])), ['o1', 'w1', 'w2']);
  assert.deepEqual(ui.mergeForUser([], [], new Set()), []);
});

/**
 * What app.js does on opening a cluster, over `page(before)` (the newest `size` messages before `before`, or the newest
 * ones; oldest first): the window's targets, then scanForUser's pages back to the read position. Returns the targets
 * the button counts and whether the scan stopped at the page limit.
 */
async function openCluster(page: (before: string | null) => Promise<any[]> | any[], readId: string | null, size: number, maxPages = 10) {
  const window = await page(null);
  const ids = window.map((m: { id: string }) => m.id);
  let found: string[] = ui.mergeForUser([], ui.unreadForUser(window, readId), new Set(ids));
  let before: string | null = window.length === size && !(readId !== null && ids.includes(readId)) ? ids[0] : null;   // loadLatest's `older`
  let pages = 0;
  let partial = false;
  while (before !== null && !partial) {
    const step = ui.forUserScanPage(await page(before), readId, { pageSize: size, pages: ++pages, maxPages });
    found = ui.mergeForUser(found, step.ids);
    ({ next: before, partial } = step);
  }
  return { found, partial, pages };
}

/** A history oldest first and its pages, as GET /api/clusters/:id/messages?limit=size(&before=) answers. */
const pager = (history: { id: string }[], size: number) => (before: string | null) => {
  const end = before === null ? history.length : history.findIndex((m) => m.id === before);
  return history.slice(Math.max(0, end - size), end);
};

test("for user: the reviewer's history: one target after the read position, then 200 messages that only @ members", async () => {
  const history = [msg('old', 'm1'), msg('R', 'user'), msg('T', 'm1', '做完了，等你确认'),
    ...Array.from({ length: 200 }, (_, i) => msg(`n${i}`, 'm2', `@B ${i}`, { mentions: ['m3'] }))];
  const { found, partial, pages } = await openCluster(pager(history, 200), 'R', 200);
  assert.deepEqual(found, ['T'], 'the newest 200 hold no target; the scan finds it before them');
  assert.equal(ui.nextForUser(found, null), 'T', 'the first click jumps to it');
  assert.equal(partial, false);
  assert.equal(pages, 1);
});

test('for user: more than a page of unread before the window; the earliest target comes first', async () => {
  const history = [msg('R', 'user'), msg('T1', 'm1', '@user 第一条'),
    ...Array.from({ length: 450 }, (_, i) => msg(`n${i}`, 'm2', `@B ${i}`, { mentions: ['m3'] })),
    msg('T2', 'm2', '第二条'), ...Array.from({ length: 150 }, (_, i) => msg(`k${i}`, 'm2', `@B ${i}`, { mentions: ['m3'] })), msg('T3', 'm1', '最新')];
  const { found, pages } = await openCluster(pager(history, 200), 'R', 200);
  assert.deepEqual(found, ['T1', 'T2', 'T3']);
  assert.equal(pages, 3);
  assert.equal(ui.nextForUser(found, null), 'T1');
  // Never read: back to the first message. Past the limit: stopped, and said so.
  assert.deepEqual((await openCluster(pager(history, 200), null, 200)).found, ['T1', 'T2', 'T3']);
  const limited = await openCluster(pager(history, 200), 'R', 200, 1);
  assert.deepEqual([limited.found, limited.partial], [['T2', 'T3'], true]);
});

async function seedForUserHistory(app: TestHub) {
  app.hub.setPaused(true);
  const { cluster, members: [a, b] } = await app.cluster('for-user', ['a', 'b']);
  const put = (from: string, body: string, mentions: string[] = []) => {
    const id = randomUUID();
    insertMessageWithEvent(app.store, { id, clusterId: cluster.id, from, mentions, body, replyTo: null, chainId: id, hop: 0, createdAt: new Date().toISOString() });
    return id;
  };
  const read = put('user', '读到这里');
  const target = put(a.id, '测试跑完了，等你决定');
  app.store.transaction(() => { for (let i = 0; i < 450; i++) put(a.id, `@b 第 ${i} 条`, [b.id]); });
  await app.api('POST', `/api/clusters/${cluster.id}/read`, { messageId: read });
  const readPosition = async () => (await app.api('GET', '/api/state')).clusters
    .find((c: { id: string }) => c.id === cluster.id).userReadMessageId;
  return { cluster, read, target, readPosition };
}

test('for user: against a test Hub, the scan pages the real messages API and the target is read around for the jump', async () => {
  const app = await startTestHub();
  try {
    const { cluster, read, target, readPosition } = await seedForUserHistory(app);
    const readId = await readPosition();
    assert.equal(readId, read);
    const path = (query: string) => `/api/clusters/${cluster.id}/messages?limit=200${query}`;
    const { found } = await openCluster((before) => app.api('GET', path(before === null ? '' : `&before=${before}`)), readId, 200);
    assert.deepEqual(found, [target]);
    const around = await app.api('GET', path(`&around=${target}`));   // what openMessage reads for a target not loaded
    assert.ok(around.some((m: { id: string }) => m.id === target));
  } finally {
    await app.close();
  }
});

const browserAvailable = findBrowser();
const skipBrowser = browserAvailable.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? browserAvailable.reason : false;

test('for user: the real page keeps the read position across a reload and offers a retry before it finds any targets',
  { skip: skipBrowser, timeout: 180_000 }, async () => {
    if (browserAvailable.path === null) assert.fail(`ORRERY_REQUIRE_BROWSER=1 but ${browserAvailable.reason}`);
    const app = await startTestHub();
    let browser: Browser | undefined;
    try {
      const { cluster, read, readPosition } = await seedForUserHistory(app);
      const messagePath = `/api/clusters/${cluster.id}/messages`;
      browser = await launchBrowser(browserAvailable.path, { redact: [TEST_TOKEN] });
      const page = browser.page;
      await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        Object.defineProperty(document, 'hasFocus', { value: () => true });
        const fetch = window.fetch.bind(window);
        let first = true;
        window.fetch = (input, init) => {
          const url = new URL(input, location.href);
          if (first && url.pathname === ${JSON.stringify(messagePath)} && url.searchParams.has('before')) {
            first = false;
            return new Promise((resolve) => {
              window.failOlderPage = () => resolve(new Response('temporary failure', { status: 503 }));
            });
          }
          return fetch(input, init);
        };
      })();` });
      await page.navigate(`${app.url}/#token=${TEST_TOKEN}`);
      const item = `[...document.querySelectorAll('#cluster-list .cluster-item')].find((button) => button.querySelector('.name')?.textContent === 'for-user')`;
      await page.waitFor(item, 'the cluster');
      await page.evaluate(`${item}.click()`);
      const button = `document.getElementById('for-user-jump')`;
      const searching = `typeof window.failOlderPage === 'function' && !${button}.hidden && ${button}.disabled`;
      await page.waitFor(searching, 'a visible search while the first older page is in flight');
      assert.equal(await readPosition(), read, 'the waiting scan has not read the rest of the chat');

      await page.navigate(`${app.url}/?reload=1#c=${cluster.id}`);
      await page.waitFor(searching, 'the reloaded chat still has older messages to search');
      assert.equal(await readPosition(), read, 'the reload retained the starting cursor');
      await page.evaluate('window.failOlderPage()');
      await page.waitFor(`!${button}.hidden && !${button}.disabled && ${button}.textContent === '重试查找'`, 'the retry button');
      assert.equal(await readPosition(), read, 'a failed first page did not consume the unread interval');
      await page.click(button, 'retry the search');
      await page.waitFor(`${button}.textContent === '1 条给你的消息'`, 'the target discovered in older history');
      await page.click(button, 'jump to the message for the user');
      await page.waitFor(`document.querySelector('#messages .for-user.jump-target')?.textContent.includes('测试跑完了，等你决定')`, 'the marked message outside the latest page');
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      assert.deepEqual(browser.problems().exceptions, []);
    } finally {
      await browser?.close();
      await app.close();
    }
  });

test('for user: the button jumps to the earliest first, then each next one, and from the last back to the earliest', () => {
  const ids = ['a', 'd', 'f'];
  assert.equal(ui.nextForUser(ids, null), 'a');
  assert.equal(ui.nextForUser(ids, 'a'), 'd');
  assert.equal(ui.nextForUser(ids, 'd'), 'f');
  assert.equal(ui.nextForUser(ids, 'f'), 'a', 'wraps');
  assert.equal(ui.nextForUser(ids, 'gone'), 'a', 'a last jump no longer counted starts over');
  assert.equal(ui.nextForUser([], 'a'), null);
});
