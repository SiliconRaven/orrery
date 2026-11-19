// The history search in the real page (headless, test/browser.ts): a keyword finds a message 350 messages back, a click
// jumps there (rendered, highlighted, with its neighbours), a message the 筛选 hides is shown with the jump note, and a
// newer search supersedes an older one whose answer comes back last. Skipped when no supported browser is installed,
// unless ORRERY_REQUIRE_BROWSER=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { insertMessageWithEvent, startTestHub, TEST_TOKEN } from './helpers.ts';

const found = findBrowser();
const skip = found.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? `no supported browser: ${found.reason}` : false;

/**
 * A page expression: an async function making a second search sheet whose Hub is a list of held requests (`asked`,
 * each with ok/fail), plus helpers to drive it as a user would and read what it shows.
 */
const FAKE_SHEET = `async () => {
  const { createChatSearch } = await import('/chat-search.js');
  const asked = [];
  const sheet = createChatSearch({ api: (_m, path) => new Promise((ok, fail) => asked.push({ path, ok, fail })), members: () => window.__fakeMembers ?? [],
    appName: (x) => x, openMessage() {}, narrow: () => false });
  const root = [...document.querySelectorAll('.chat-search')].at(-1);
  const q = root.querySelector('.search-q');
  const page = (prefix, n, cursor) => ({ items: Array.from({ length: n }, (_, i) => ({ id: prefix + i, from: 'user', createdAt: new Date().toISOString(),
    kind: 'chat', snippet: prefix + i, marks: [] })), cursor, reason: cursor ? 'limit' : null });
  return {
    sheet, asked, root, q, page,
    tick: (ms = 0) => new Promise((r) => setTimeout(r, ms)),
    type: (text, composing = false) => { q.value = text; q.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: composing })); },
    enter: (composing = false) => q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: composing })),
    more: root.querySelector('.search-more'),
    order: root.querySelector('.search-order'),
    rows: () => [...root.querySelectorAll('.search-snippet')].map((p) => p.textContent),
    status: () => root.querySelector('.search-status').textContent,
    done: () => { sheet.close(); root.remove(); },
  };
}`;

test('browser: search finds an old message, the click jumps to it through the filter; a stale answer is ignored', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, 'ORRERY_REQUIRE_BROWSER=1 but no supported browser');
  const app = await startTestHub();
  app.hub.setPaused(true);
  let browser: Browser | null = null;
  let step = 'setup';
  try {
    const { cluster, members: [a, b] } = await app.cluster('history', ['A', 'B']);
    const start = Date.now() - 400 * 60_000;
    app.store.transaction(() => {
      for (let i = 0; i < 400; i++) {
        const id = randomUUID();
        const from = i % 2 ? a.id : b.id;
        insertMessageWithEvent(app.store, { id, clusterId: cluster.id, from, mentions: [], replyTo: null, chainId: id, hop: 0,
          body: i === 50 ? 'the Needle-Target is here' : `message ${i}`, createdAt: new Date(start + i * 60_000).toISOString() });
      }
    });
    browser = await launchBrowser(found.path!, { redact: [TEST_TOKEN] });
    const page = browser.page;
    const item = `[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'history')`;
    const row = (text: string) => `[...document.querySelectorAll('#messages article.msg')].find((a) => a.querySelector('.msg-body')?.textContent.trim() === ${JSON.stringify(text)})`;
    const target = `[...document.querySelectorAll('#messages article.msg')].find((a) => a.textContent.includes('Needle-Target is here'))`;
    const result = `[...document.querySelectorAll('#chat-search .search-result')].find((r) => r.textContent.includes('Needle-Target'))`;

    step = 'open the cluster';
    await page.navigate(`${app.url}/#token=${TEST_TOKEN}`);
    await page.waitFor(item, 'the cluster');
    await page.click(item, 'the cluster');
    await page.waitFor(row('message 399'), 'the newest message');
    assert.equal(await page.evaluate(`Boolean(${target})`), false, 'the target is far outside the loaded window');

    step = 'search';
    await page.click(`document.getElementById('chat-search-open')`, 'the search button');
    await page.waitFor(`!document.getElementById('chat-search').hidden`, 'the search sheet');
    await page.type(`document.querySelector('#chat-search .search-q')`, 'needle-target', 'the keyword');
    await page.waitFor(result, 'the result');
    assert.equal(await page.evaluate(`${result}.querySelector('mark').textContent`), 'Needle-Target', 'the hit is highlighted, in the message’s own case');
    assert.equal(await page.evaluate(`${result}.querySelector('.search-who').textContent`), 'B');

    step = 'jump to the result';
    await page.click(result, 'the result');
    await page.waitFor(`${target}?.classList.contains('jump-target')`, 'the target rendered and highlighted');
    for (const neighbour of ['message 49', 'message 51']) assert.ok(await page.evaluate(`Boolean(${row(neighbour)})`), `${neighbour} is loaded around it`);
    assert.equal(await page.evaluate(`!document.getElementById('chat-search').hidden`), true, 'a wide window keeps the sheet open');

    step = 'a filter that hides it';
    await page.evaluate(`(() => { const s = document.querySelector('#chat-filter select[data-filter-sender]'); s.value = ${JSON.stringify(a.id)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await page.waitFor(`!${target}`, 'the target hidden by 只看 A');
    await page.click(result, 'the result again');
    await page.waitFor(`${target}?.querySelector('.jump-shown')`, 'the target shown by the jump, with the note');

    step = 'a stale answer';
    // A second sheet on a fake Hub (FAKE_SHEET): the first search answers last and must not replace the newer one's results.
    const stale = await page.evaluate<unknown[]>(`(async () => {
      const f = await (${FAKE_SHEET})();
      f.sheet.open('fake');
      f.type('old'); f.enter();
      f.type('new'); f.enter();
      f.asked[1].ok(f.page('new', 1, null)); await f.tick();
      f.asked[0].ok(f.page('old', 1, null)); await f.tick();
      const rows = f.rows();
      f.done();
      return [f.asked.length, ...rows];
    })()`);
    assert.deepEqual(stale, [2, 'new0']);
    assert.deepEqual(browser.problems().exceptions, []);
    assert.equal(b.name, 'B');
  } catch (error) {
    const problems = browser?.problems() ?? { console: [], exceptions: [] };
    throw new Error(`failed at "${step}": ${(error as Error).message}\nconsole: ${problems.console.join('\n')}\nexceptions: ${problems.exceptions.join('\n')}`, { cause: error });
  } finally {
    await browser?.close();
    await app.close();
  }
});

test('browser: the search sheet stays consistent under racing actions (load more, sort, close, Esc, IME)', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, 'ORRERY_REQUIRE_BROWSER=1 but no supported browser');
  const app = await startTestHub();
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser(found.path!, { redact: [TEST_TOKEN] });
    const page = browser.page;
    await page.navigate(`${app.url}/#token=${TEST_TOKEN}`);
    await page.waitFor(`document.getElementById('chat-search')`, 'the page');
    const run = (body: string) => page.evaluate<any>(`(async () => { const f = await (${FAKE_SHEET})(); try { ${body} } finally { f.done(); } })()`);
    const firstPage = `f.sheet.open('fake'); f.type('old'); f.enter(); f.asked[0].ok(f.page('old', 30, '7')); await f.tick();`;

    // 1. A new keyword, then "load more" before the pause ends: no old page appended, the new keyword searched and kept.
    const one = await run(`${firstPage}
      const shown = !f.more.hidden;
      f.type('new');
      const hidden = f.more.hidden;
      f.more.click();
      const askedNow = f.asked.length;
      await f.tick(400);
      const path = f.asked[1]?.path ?? '';
      f.asked[1].ok(f.page('new', 2, null)); await f.tick();
      return { shown, hidden, askedNow, newSearch: path.includes('q=new') && !path.includes('cursor'), rows: f.rows(), input: f.q.value, more: f.more.hidden };`);
    assert.deepEqual(one, { shown: true, hidden: true, askedNow: 1, newSearch: true, rows: ['new0', 'new1'], input: 'new', more: true });

    // 2. The sort toggle while a new keyword waits: the input keeps it, the search asks for it in the new order.
    const two = await run(`${firstPage}
      f.type('new');
      f.order.click();
      const path = f.asked[1].path;
      await f.tick(400);
      return { input: f.q.value, path, asked: f.asked.length };`);
    assert.equal(two.input, 'new');
    assert.match(two.path, /q=new&order=asc/);
    assert.equal(two.asked, 2, 'the pending pause did not search again');

    // 3. Closed and reopened while the next page is out: the page before it, its button, no spinner; the late answer is dropped.
    const three = await run(`${firstPage}
      f.more.click();
      const loading = f.status();
      f.sheet.close(); f.sheet.open('fake');
      const reopened = { status: f.status(), more: !f.more.hidden, rows: f.rows().length };
      f.asked[1].ok(f.page('late', 30, null)); await f.tick();
      return { loading, reopened, after: f.rows().length };`);
    assert.deepEqual(three, { loading: '正在继续搜索…', reopened: { status: '找到 30 条，还有更多。', more: true, rows: 30 }, after: 30 });

    // Esc while a new search is out: closed; reopened, the stable page shows; the answer lands nowhere.
    const esc = await run(`${firstPage}
      f.type('other'); f.enter();
      f.q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const closed = f.root.hidden;
      f.sheet.open('fake');
      const back = { input: f.q.value, status: f.status(), rows: f.rows().length };
      f.asked[1].ok(f.page('other', 1, null)); await f.tick();
      return { closed, back, rows: f.rows().length };`);
    assert.deepEqual(esc, { closed: true, back: { input: 'old', status: '找到 30 条，还有更多。', rows: 30 }, rows: 30 });

    // IME: nothing is searched mid-composition (input or Enter); compositionend starts the pause.
    const ime = await run(`f.sheet.open('fake');
      f.type('bu', true); f.enter(true);
      await f.tick(400);
      const during = f.asked.length;
      f.type('部署', true); f.q.dispatchEvent(new CompositionEvent('compositionend', { data: '部署' }));
      await f.tick(400);
      return { during, after: f.asked.length, path: decodeURIComponent(f.asked[0]?.path ?? '') };`);
    assert.deepEqual([ime.during, ime.after], [0, 1]);
    assert.match(ime.path, /q=部署/);
    // Ordinary typing arms the pause, then a composition starts without ending: the armed pause must not send the draft.
    const armed = await run(`f.sheet.open('fake');
      f.type('pin');
      f.type('pinyin-draft', true);
      await f.tick(400);
      const byInput = f.asked.length;
      f.type('x');
      f.q.dispatchEvent(new CompositionEvent('compositionstart'));
      await f.tick(400);
      return { byInput, byStart: f.asked.length, input: f.q.value };`);
    assert.deepEqual(armed, { byInput: 0, byStart: 0, input: 'x' });

    // A failed continuation: the page stays, with its button and the reason.
    const failed = await run(`${firstPage}
      f.more.click();
      f.asked[1].fail(new Error('Hub down')); await f.tick();
      return { status: f.status(), more: !f.more.hidden, rows: f.rows().length };`);
    assert.deepEqual(failed, { status: '找到 30 条，还有更多。 继续搜索失败：Hub down', more: true, rows: 30 });

    // The chosen sender leaves the group while the sheet is open: still chosen, now marked 已移出, nothing searched again.
    const left = await run(`
      window.__fakeMembers = [{ id: 'm1', clusterId: 'fake', name: 'A', harness: 'mock', removedAt: null, hiddenAt: null }];
      f.sheet.open('fake');
      const select = f.root.querySelector('select[aria-label="发送者"]');
      select.value = 'm1'; select.dispatchEvent(new Event('change'));
      f.asked[0].ok(f.page('a', 2, null)); await f.tick();
      window.__fakeMembers = [{ ...window.__fakeMembers[0], removedAt: 'now' }];
      f.sheet.sync('fake');
      const out = { value: select.value, label: select.selectedOptions[0].textContent, asked: f.asked.length, rows: f.rows().length };
      delete window.__fakeMembers;
      return out;`);
    assert.deepEqual(left, { value: 'm1', label: 'A（已移出）', asked: 1, rows: 2 });
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await app.close();
  }
});

test('browser: a new hidden warning shows on the filter control in an older window and at the newest messages', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, 'ORRERY_REQUIRE_BROWSER=1 but no supported browser');
  const app = await startTestHub();
  app.hub.setPaused(true);
  let browser: Browser | null = null;
  let step = 'setup';
  try {
    const { cluster, members: [a] } = await app.cluster('warnings', ['A']);
    const second = (await app.cluster('second', ['B'])).cluster;
    const start = Date.now() - 400 * 60_000;
    app.store.transaction(() => {
      for (let i = 0; i < 400; i++) {
        const id = randomUUID();
        insertMessageWithEvent(app.store, { id, clusterId: cluster.id, from: a.id, mentions: [], replyTo: null, chainId: id, hop: 0,
          body: i === 40 ? 'far back target' : `message ${i}`, createdAt: new Date(start + i * 60_000).toISOString() });
      }
    });
    const warn = (body: string, clusterId = cluster.id) => {
      const id = randomUUID();
      (app.hub as any).post({ id, clusterId, from: 'system', kind: 'system', systemKind: 'stalled', mentions: [], body, replyTo: null,
        chainId: id, hop: 0, createdAt: new Date().toISOString() }, []);
    };
    browser = await launchBrowser(found.path!, { redact: [TEST_TOKEN] });
    const page = browser.page;
    const item = `[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'warnings')`;
    const badge = `document.getElementById('chat-filter-warnings')`;
    const live = `document.getElementById('chat-filter-live').textContent`;
    await page.navigate(`${app.url}/#token=${TEST_TOKEN}`);
    await page.waitFor(item, 'the cluster');
    await page.click(item, 'the cluster');
    await page.waitFor(`[...document.querySelectorAll('#messages article.msg')].some((m) => m.textContent.includes('message 399'))`, 'the newest');

    step = 'jump back about 360 messages, hide warnings';
    await page.click(`document.getElementById('chat-search-open')`, 'search');
    await page.type(`document.querySelector('#chat-search .search-q')`, 'far back target', 'the keyword');
    const result = `document.querySelector('#chat-search .search-result')`;
    await page.waitFor(result, 'the result');
    await page.click(result, 'the result');
    await page.waitFor(`!document.getElementById('message-window').hidden`, 'an older window');
    await page.evaluate(`(document.querySelector('#chat-search .search-head button').click(), true)`);
    await page.evaluate(`(() => { const d = document.getElementById('chat-filter'); d.open = true; d.querySelector('input[data-filter="warning"]').click(); d.open = false; return true; })()`);
    assert.equal(await page.evaluate(`${badge}.hidden`), true, 'no warnings loaded, none arrived');

    step = 'a new warning while viewing history';
    warn('stalled while you read history');
    await page.waitFor(`${live} === '筛选隐藏了 1 条新到的警告。'`, 'the polite announcement');
    await page.waitFor(`!${badge}.hidden && ${badge}.textContent === '警告 新 1'`, 'the badge shows the arrival although it is not loaded');
    assert.equal(await page.evaluate(`${badge}.classList.contains('new')`), true);
    assert.equal(await page.evaluate(`document.getElementById('message-window-text').textContent`), '有新消息。');

    step = 'back to the newest messages';
    await page.click(`document.getElementById('message-window-latest')`, '回到最新');
    await page.waitFor(`${badge}.textContent === '警告 1 · 新 1'`, 'loaded and hidden, and still new');
    warn('another one at the newest');
    await page.waitFor(`${badge}.textContent === '警告 2 · 新 2' && ${live} === '筛选隐藏了 2 条新到的警告。'`, 'the second arrival');

    step = 'seen in the panel';
    await page.evaluate(`(document.getElementById('chat-filter').open = true, true)`);
    assert.match(await page.evaluate<string>(`document.querySelector('.chat-filter-hidden').textContent`), /2 条警告被筛选隐藏.*新到 2 条/);
    await page.evaluate(`(document.getElementById('chat-filter').open = false, true)`);
    await page.waitFor(`${badge}.textContent === '警告 2' && !${badge}.classList.contains('new')`, 'no longer new, still hidden');

    step = 'a per-cluster sender change leaves other clusters’ arrivals';
    warn('hidden in the second cluster', second.id);
    warn('hidden here too');
    await page.waitFor(`${badge}.textContent === '警告 3 · 新 1'`, 'the arrival here');
    assert.equal(await page.evaluate(`${live}`), '筛选隐藏了 1 条新到的警告。', 'only this cluster’s arrival is announced');
    await page.evaluate(`(() => { const s = document.querySelector('#chat-filter select[data-filter-sender]'); s.value = ${JSON.stringify(a.id)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await page.waitFor(`${badge}.textContent === '警告 3'`, 'this cluster’s arrivals cleared by its own sender change');
    const secondItem = `[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'second')`;
    await page.click(secondItem, 'the second cluster');
    await page.waitFor(`${badge}.textContent === '警告 1 · 新 1'`, 'the second cluster still shows its arrival');

    step = 'a global switch clears every cluster’s arrivals';
    await page.evaluate(`(() => { const d = document.getElementById('chat-filter'); d.querySelector('input[data-filter="task"]').click(); return true; })()`);
    await page.waitFor(`${badge}.textContent === '警告 1'`, 'cleared by a switch that applies everywhere');
    assert.deepEqual(browser.problems().exceptions, []);
  } catch (error) {
    const problems = browser?.problems() ?? { console: [], exceptions: [] };
    throw new Error(`failed at "${step}": ${(error as Error).message}\nconsole: ${problems.console.join('\n')}\nexceptions: ${problems.exceptions.join('\n')}`, { cause: error });
  } finally {
    await browser?.close();
    await app.close();
  }
});
