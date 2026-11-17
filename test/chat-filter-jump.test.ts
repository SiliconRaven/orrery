// The chat filter and explicit jumps, in the real page (headless, test/browser.ts): with 只看警告 on, a jump from the
// 有问题的投递 dialog still shows its message, marked, with its receipts open; changing the filter ends that exception.
// Skipped when no supported browser is installed, unless ORRERY_REQUIRE_BROWSER=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { startTestHub, tempDir, TEST_TOKEN, waitFor } from './helpers.ts';

const found = findBrowser();
const skip = found.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? `no supported browser: ${found.reason}` : false;

test('browser: with 只看警告 on, a jump from the delivery problems opens the hidden message and its receipts', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, 'ORRERY_REQUIRE_BROWSER=1 but no supported browser');
  const dir = tempDir();
  const sessions = ['s1', 's2'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ harness: 'claude', sessions });
  native.isOnline = (sessionId) => sessionId !== 's2';   // B is offline: a message to it is a problem delivery
  const app = await startTestHub({ dir, nativeAdapters: { claude: native } });
  let browser: Browser | null = null;
  let step = 'setup';
  try {
    const { cluster } = await app.hub.createCluster('jumps', [
      { harness: 'claude', mode: 'native', sessionId: 's1', name: 'A' },
      { harness: 'claude', mode: 'native', sessionId: 's2', name: 'B' },
    ]);
    const sent = app.hub.sendFromUser(cluster.id, '@B offline hello');
    await waitFor(() => app.store.withDeliveries([sent])[0].deliveries.some((d) => d.state === 'offline'), 'the offline delivery');
    browser = await launchBrowser(found.path!, { redact: [TEST_TOKEN] });
    const page = browser.page;
    const item = `[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'jumps')`;
    const message = `[...document.querySelectorAll('#messages article.msg.user')].find((a) => a.textContent.includes('offline hello'))`;
    const warningsOnly = `document.querySelector('#chat-filter input[data-filter="warningsOnly"]')`;

    step = 'open the cluster';
    await page.navigate(`${app.url}/#token=${TEST_TOKEN}`);
    await page.waitFor(item, 'the cluster');
    await page.click(item, 'the cluster');
    await page.waitFor(message, 'the user message behind the problem delivery');

    step = 'only warnings';
    await page.evaluate(`(document.getElementById('chat-filter').open = true, true)`);
    await page.click(warningsOnly, 'only warnings');
    await page.waitFor(`!${message}`, 'the user message hidden by the filter');

    step = 'jump from the problems dialog';
    await page.waitFor(`!document.getElementById('delivery-problems').hidden`, 'the delivery problems button');
    await page.evaluate(`(document.getElementById('chat-filter').open = false, true)`);
    await page.click(`document.getElementById('delivery-problems')`, 'the delivery problems button');
    const entry = `[...document.querySelectorAll('.problem-list .receipt-action')].find((b) => b.textContent.includes('offline hello'))`;
    await page.waitFor(entry, 'the problem entry');
    await page.click(entry, 'the problem entry');
    await page.waitFor(`${message}?.querySelector('.jump-shown') && ${message}.querySelector('.receipts')?.open`,
      'the message shown by the jump, marked, with its receipts open');
    assert.equal(await page.evaluate(`document.querySelectorAll('#messages article.msg.user').length`), 1, 'only the target is let through');

    step = 'changing the filter ends the exception';
    await page.evaluate(`(document.getElementById('chat-filter').open = true, true)`);
    await page.click(warningsOnly, 'only warnings off');
    await page.waitFor(`${message} && !${message}.querySelector('.jump-shown')`, 'the message shown normally, unmarked');
    await page.click(warningsOnly, 'only warnings on again');
    await page.waitFor(`!${message}`, 'hidden again: the jump no longer applies');
    assert.deepEqual(browser.problems().exceptions, []);
  } catch (error) {
    const problems = browser?.problems() ?? { console: [], exceptions: [] };
    throw new Error(`failed at "${step}": ${(error as Error).message}\nconsole: ${problems.console.join('\n')}\nexceptions: ${problems.exceptions.join('\n')}`, { cause: error });
  } finally {
    await browser?.close();
    await app.close();
  }
});

/**
 * A pass-through proxy that can hold the page's history jump and its initial latest read independently.
 */
async function holdingProxy(target: string) {
  const hub = new URL(target);
  let hold = false;
  const held: (() => void)[] = [];
  let holdLatest = false;
  const latest: (() => void)[] = [];
  let answered = 0;
  const server: Server = createServer((req, res) => {
    const forward = () => {
      const upstream = request({ host: hub.hostname, port: hub.port, path: req.url, method: req.method, headers: { ...req.headers, host: hub.host, ...(req.headers.origin ? { origin: hub.origin } : {}), ...(req.headers.referer ? { referer: hub.origin + '/' } : {}) } }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
        if (req.url?.includes('around=')) answer.on('end', () => { answered++; });
      });
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    };
    if (hold && req.url?.includes('around=')) held.push(forward);
    else if (holdLatest && /\/messages\?limit=\d+$/.test(req.url ?? '')) latest.push(forward);
    else forward();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    holdAround() { hold = true; },
    holdLatest() { holdLatest = true; },
    heldCount: () => held.length,
    heldLatest: () => latest.length,
    answered: () => answered,
    release() { hold = false; for (const go of held.splice(0)) go(); },
    releaseLatest() { holdLatest = false; for (const go of latest.splice(0)) go(); },
    close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

async function cancelledJump(cold: boolean) {
  assert.ok(found.path, 'ORRERY_REQUIRE_BROWSER=1 but no supported browser');
  const dir = tempDir();
  const sessions = ['s1', 's2'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ harness: 'claude', sessions });
  native.isOnline = (sessionId) => sessionId !== 's2';
  const app = await startTestHub({ dir, nativeAdapters: { claude: native } });
  const proxy = await holdingProxy(app.url);
  let browser: Browser | null = null;
  let step = 'setup';
  try {
    const { cluster } = await app.hub.createCluster('late', [
      { harness: 'claude', mode: 'native', sessionId: 's1', name: 'A' },
      { harness: 'claude', mode: 'native', sessionId: 's2', name: 'B' },
    ]);
    const original = app.hub.sendFromUser(cluster.id, '@B the original offline message');
    await waitFor(() => app.store.withDeliveries([original])[0].deliveries.some((d) => d.state === 'offline'), 'the offline delivery');
    for (let i = 0; i <= 200; i++) app.hub.sendFromUser(cluster.id, `filler ${i}`);   // 201 newer: the original is outside the window
    browser = await launchBrowser(found.path!, { redact: [TEST_TOKEN] });
    const page = browser.page;
    const item = `[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'late')`;
    const userRow = (text: string) => `[...document.querySelectorAll('#messages article.msg.user')].find((a) => a.textContent.includes(${JSON.stringify(text)}))`;
    const warningsOnly = `document.querySelector('#chat-filter input[data-filter="warningsOnly"]')`;
    const openReceipts = `document.querySelectorAll('#messages .receipts[open]').length`;
    const atBottom = `(() => { const b = document.getElementById('messages'); return b.scrollHeight - b.scrollTop - b.clientHeight < 60; })()`;

    step = 'open the cluster';
    if (cold) proxy.holdLatest();
    await page.navigate(`${proxy.url}/#token=${TEST_TOKEN}`);
    await page.waitFor(item, 'the cluster');
    await page.click(item, 'the cluster');
    if (cold) await waitFor(() => proxy.heldLatest() === 1, 'the initial latest read, held');
    else await page.waitFor(userRow('filler 200'), 'the newest messages');
    assert.equal(await page.evaluate(`Boolean(${userRow('the original offline')})`), false, 'the original is outside the window');

    step = 'jump, held';
    await page.waitFor(`!document.getElementById('delivery-problems').hidden`, 'the delivery problems button');
    await page.click(`document.getElementById('delivery-problems')`, 'the delivery problems button');
    const entry = `[...document.querySelectorAll('.problem-list .receipt-action')].find((b) => b.textContent.includes('the original offline'))`;
    await page.waitFor(entry, 'the problem entry');
    proxy.holdAround();
    await page.click(entry, 'the problem entry');
    await waitFor(() => proxy.heldCount() === 1, 'the around read, held');

    step = 'filter change before the answer';
    await page.evaluate(`(document.getElementById('chat-filter').open = true, true)`);
    await page.click(warningsOnly, 'only warnings');
    proxy.releaseLatest();   // if held, its old token has already been replaced by the jump
    proxy.release();
    await waitFor(() => proxy.answered() === 1, 'the around read answered');
    await sleep(500);
    assert.equal(await page.evaluate(`Boolean(${userRow('the original offline')})`), false, 'the cancelled target stays hidden');
    assert.equal(await page.evaluate(openReceipts), 0);

    step = 'filter off: the cancelled jump does not come back';
    await page.click(warningsOnly, 'only warnings off');
    await page.waitFor(`document.querySelectorAll('#messages article.msg.user').length > 0`, 'the chat shown again');
    await sleep(500);
    assert.equal(await page.evaluate(openReceipts), 0, 'no receipts opened by the long-gone jump');
    assert.equal(await page.evaluate(`Boolean(${userRow('the original offline')})`), false, 'the window is the newest one, as before the jump');
    assert.equal(await page.evaluate(`Boolean(${userRow('filler 200')})`), true);

    step = 'follows the bottom';
    await page.evaluate(`(document.getElementById('chat-filter').open = false, document.getElementById('messages').scrollTop = 1e9, true)`);
    app.hub.sendFromUser(cluster.id, 'after the cancelled jump');
    await page.waitFor(userRow('after the cancelled jump'), 'a new message in the chat');
    await page.waitFor(atBottom, 'the chat at the bottom');
    assert.deepEqual(browser.problems().exceptions, []);
  } catch (error) {
    const problems = browser?.problems() ?? { console: [], exceptions: [] };
    throw new Error(`failed at "${step}": ${(error as Error).message}\nconsole: ${problems.console.join('\n')}\nexceptions: ${problems.exceptions.join('\n')}`, { cause: error });
  } finally {
    await browser?.close();
    proxy.releaseLatest();
    proxy.release();
    await proxy.close();
    await app.close();
  }
}

test('browser: a filter change while a jump is still reading history cancels it; the late answer revives nothing and the chat follows the bottom',
  { skip, timeout: 180_000 }, () => cancelledJump(false));
test('browser: cancelling a jump before the first chat window exists still loads the latest messages',
  { skip, timeout: 180_000 }, () => cancelledJump(true));
