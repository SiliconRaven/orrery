// The recycle bin dialog (src/web/public/trash.js): the pure confirmation and result helpers in node, then the whole
// flow in the real page with a headless browser (skipped without one, as browser-smoke.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';
import type { NativeDeliverContext } from '../src/core/types.ts';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { startTestHub, TEST_TOKEN, waitFor } from './helpers.ts';

const trash = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'trash.js')).href);

test('trash ui: one cluster is confirmed by its exact name, several by "永久删除 N 个群"', () => {
  const one = [{ id: '1', name: 'alpha team' }];
  const two = [{ id: '1', name: 'alpha' }, { id: '2', name: 'beta' }];
  assert.equal(trash.purgePhrase(one), 'alpha team');
  assert.equal(trash.purgePhrase(two), '永久删除 2 个群');
  assert.equal(trash.purgeConfirmed(one, 'alpha team'), true);
  for (const text of ['', 'alpha', 'alpha team ', 'Alpha team', ' alpha team']) assert.equal(trash.purgeConfirmed(one, text), false, JSON.stringify(text));
  assert.equal(trash.purgeConfirmed(two, '永久删除 2 个群'), true);
  for (const text of ['永久删除 3 个群', '永久删除2个群', 'alpha', '永久删除 2 个群 ']) assert.equal(trash.purgeConfirmed(two, text), false, JSON.stringify(text));
  assert.equal(trash.purgeConfirmed([], ''), false, 'nothing ticked: nothing to confirm');
  assert.equal(trash.purgeCounts({ messageCount: 12, fileCount: 3 }), '12 条消息 · 3 个上传文件');
  assert.equal(trash.purgeCounts({}), '0 条消息 · 0 个上传文件');
});

test('trash ui: each purge answer becomes one plain result line', () => {
  assert.deepEqual(trash.purgeOutcome({ ok: true, data: { filesFailed: [] } }), { tone: 'done', text: '已永久删除' });
  assert.match(trash.purgeOutcome({ ok: true, data: { filesFailed: ['a', 'b'] } }).text, /已永久删除，但有 2 个上传文件没能从磁盘删掉/);
  assert.equal(trash.purgeOutcome({ ok: true, data: { filesFailed: ['a'] } }).tone, 'partial');
  const running = trash.purgeOutcome({ ok: false, status: 409, data: { code: 'RUNNING', member: 'A' } });
  assert.deepEqual(running, { tone: 'refused', text: '没有删除：成员 A 还有执行没结束，等它结束后再试' });
  assert.match(trash.purgeOutcome({ ok: false, status: 409, data: { code: 'NOT_IN_TRASH' } }).text, /已被恢复/);
  assert.deepEqual(trash.purgeOutcome({ ok: false, status: 409, data: { code: 'PLUGIN_DATA', plugins: ['refs', 'other'], error: 'nothing was deleted: …' } }), { tone: 'refused',
    text: '没有删除：插件 refs、other 这次没有运行，它们的数据表可能还存着这个群的数据，很可能就是删不掉的原因。重新信任或打开它们并重启 Hub 后再删，或先手动清理它们的表' });
  assert.match(trash.purgeOutcome({ ok: false, status: 404, data: { code: 'NOT_FOUND' } }).text, /已经不存在/);
  assert.match(trash.purgeOutcome({ ok: false, status: 409, data: { code: 'NAME_MISMATCH' } }).text, /不一致/);
  assert.equal(trash.purgeOutcome({ ok: false, status: 400, data: { error: 'boom' } }).text, '没有删除：boom');
  assert.equal(trash.purgeOutcome({ ok: false, status: 502 }).text, '删除结果未确认：HTTP 502');
});

const found = findBrowser();
const skip = found.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? `no supported browser: ${found.reason}` : false;

test('trash ui in the page: tick two, type the phrase, one is deleted and one refused because it still runs', { skip, timeout: 120_000 }, async () => {
  const hub = await startTestHub();
  const runs: PromiseWithResolvers<'completed'>[] = [];
  let browser: Browser | null = null;
  try {
    const alpha = await hub.hub.createCluster('alpha', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const beta = await hub.hub.createCluster('beta', [{ harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' }]);
    const remote = await hub.cluster('removed elsewhere', ['C']);
    hub.hub.sendFromUser(alpha.cluster.id, '@A hello');
    await waitFor(() => hub.store.runningDeliveries().length === 0, 'alpha settled');
    hub.native.deliver = async (_s: string, _t: string, _ctx: NativeDeliverContext) => { const gate = Promise.withResolvers<'completed'>(); runs.push(gate); return gate.promise; };
    hub.hub.sendFromUser(beta.cluster.id, '@B still working');
    await waitFor(() => runs.length === 1, 'beta running');
    hub.hub.deleteCluster(alpha.cluster.id);
    hub.hub.deleteCluster(beta.cluster.id);
    hub.hub.deleteCluster(remote.cluster.id);

    browser = await launchBrowser(found.path!, { redact: [TEST_TOKEN] });
    const page = browser.page;
    await page.navigate(`${hub.url}/#token=${TEST_TOKEN}`);
    await page.waitFor(`document.getElementById('open-trash')`, 'the recycle bin button');
    await page.click(`document.getElementById('open-trash')`, 'the recycle bin button');
    const row = (name: string) => `[...document.querySelectorAll('.trash-row')].find((r) => r.querySelector('.trash-name')?.textContent === ${JSON.stringify(name)})`;
    await page.waitFor(`${row('beta')}`, 'the rows');
    await page.waitFor(row('removed elsewhere'), 'the row to be removed by another client');
    const entry = hub.hub.listDeletedClusters().find((c) => c.id === remote.cluster.id)!;
    await hub.api('POST', `/api/clusters/${entry.id}/purge`, { name: entry.name, trashVersion: entry.trashVersion });
    await page.waitFor(`!${row('removed elsewhere')}`, 'the open recycle bin to receive the tombstone');
    assert.match(await page.evaluate<string>(`${row('alpha')}.textContent`), /^alpha1 条消息 · 0 个上传文件恢复$/);
    const purge = `[...document.querySelectorAll('.trash-dialog button')].find((b) => b.textContent === '永久删除所选')`;
    assert.equal(await page.evaluate(`${purge}.disabled`), true, 'nothing ticked');

    // One ticked: the cluster's name; cancel deletes nothing.
    await page.click(`${row('alpha')}.querySelector('input[type=checkbox]')`, 'alpha');
    assert.equal(await page.evaluate(`${purge}.disabled`), false);
    await page.click(purge, 'purge');
    await page.waitFor(`document.activeElement?.id === 'purge-confirm-input'`, 'focus in the confirmation input');
    const confirm = `document.querySelector('dialog.purge-confirm button[value=confirm]')`;
    assert.equal(await page.evaluate(`${confirm}.disabled`), true);
    assert.match(await page.evaluate<string>(`document.querySelector('dialog.purge-confirm').textContent`), /不能撤销.*会删除.*不会动/s);
    await page.click(`[...document.querySelectorAll('dialog.purge-confirm button')].find((b) => b.textContent === '取消')`, 'cancel');
    await page.waitFor(`!document.querySelector('dialog.purge-confirm')`, 'the confirmation to close');
    assert.ok(hub.store.getCluster(alpha.cluster.id, { includeDeleted: true }));

    // Two ticked: the count phrase; the confirm button waits for the exact text.
    await page.click(`${row('beta')}.querySelector('input[type=checkbox]')`, 'beta');
    await page.click(purge, 'purge');
    await page.waitFor(`document.activeElement?.id === 'purge-confirm-input'`, 'focus in the confirmation input');
    await page.type(`document.getElementById('purge-confirm-input')`, '永久删除 2 个', 'the confirmation input');
    assert.equal(await page.evaluate(`${confirm}.disabled`), true, 'not the whole phrase yet');
    await page.type(`document.getElementById('purge-confirm-input')`, '群', 'the confirmation input');
    assert.equal(await page.evaluate(`${confirm}.disabled`), false);
    await page.click(confirm, 'confirm');
    const results = await page.waitFor<string[]>(`(() => {
      const items = [...document.querySelectorAll('.trash-results li')];
      return items.length === 2 && !document.querySelector('.trash-results p') ? items.map((li) => li.className + ' ' + li.textContent) : null;
    })()`, 'both results');
    assert.match(results[0], /^purge-done alpha：已永久删除/);
    assert.match(results[1], /^purge-refused beta：没有删除：成员 B 还有执行没结束/);
    await page.waitFor(`!${row('alpha')} && ${row('beta')}`, 'the list to show only beta');
    assert.equal(hub.store.getCluster(alpha.cluster.id, { includeDeleted: true }), null);
    assert.ok(hub.store.getCluster(beta.cluster.id, { includeDeleted: true }));
    assert.equal(await page.evaluate(`${row('beta')}.querySelector('input').checked`), true, 'the refused one stays ticked');
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    for (const gate of runs) gate.resolve('completed');
    await browser?.close();
    await hub.close();
  }
});
