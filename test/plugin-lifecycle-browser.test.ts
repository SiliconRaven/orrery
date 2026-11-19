// A third-party plugin's card in the real page (headless, test/browser.ts; docs/external-plugins.md「生命周期」): stop,
// start and restart from its buttons; a stop made elsewhere (the HTTP API) reaches the open card through the stream
// without a reload; the automatic restart switch is saved. Uses the shared profile slots, like the other browser tests;
// a supported browser must be installed unless ORRERY_REQUIRE_BROWSER=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { startTestHub, tempDir, TEST_TOKEN } from './helpers.ts';

const found = findBrowser();
const skip = found.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? `no supported browser: ${found.reason}` : false;

const script = `
import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
createInterface({input:process.stdin}).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{apiVersion:1}});
  if (m.method === 'shutdown') return send({id:m.id,result:{}});
  if (m.id !== undefined) send({id:m.id,result:process.pid});
});
`;

test('browser: the plugin card stops, starts and restarts its plugin, and follows a stop made elsewhere', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, 'ORRERY_REQUIRE_BROWSER=1 but no supported browser');
  const dir = tempDir();
  const folder = join(dir, 'plugins', 'card-demo');
  mkdirSync(folder, { recursive: true });
  mkdirSync(join(dir, 'home'));
  writeFileSync(join(folder, 'main.mjs'), script);
  writeFileSync(join(folder, 'orrery-plugin.json'), JSON.stringify({ id: 'card-demo', version: '1.0.0', name: '卡片示例', apiVersion: 1,
    entry: 'main.mjs', permissions: [], commands: [{ id: 'pid', title: 'pid', clusterScoped: false }] }));
  writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: [{ manifest: join(folder, 'orrery-plugin.json') }] }));
  const app = await startTestHub({ dir });
  let browser: Browser | null = null;
  let step = 'setup';
  try {
    browser = await launchBrowser(found.path!, { redact: [TEST_TOKEN] });
    const page = browser.page;
    const card = `document.querySelector('[data-plugin-live="card-demo"]')`;
    const live = (text: string) => `${card}?.textContent.includes(${JSON.stringify(text)})`;
    const button = (action: string) => `${card}.querySelector('[data-plugin-action="${action}"]')`;
    const pid = async () => (await app.api('POST', '/api/plugins/card-demo/invoke', { command: 'pid' })).result as number;

    step = 'open the plugin settings';
    await page.navigate(`${app.url}/#token=${TEST_TOKEN}`);
    await page.waitFor(`document.getElementById('open-settings')`, 'the settings button');
    await page.click(`document.getElementById('open-settings')`, 'settings');
    await page.click(`document.getElementById('settings-tab-plugins')`, 'the plugins tab');
    await page.waitFor(live('外部进程：ready'), 'the card, ready');

    step = 'stop from the card';
    await page.click(button('stop'), 'stop');
    await page.waitFor(live('外部进程：stopped'), 'stopped');
    await page.waitFor(`${button('start')}?.disabled === false`, 'the start button');
    assert.equal(await page.evaluate(`Boolean(${button('stop')})`), false, 'no stop button on a stopped plugin');

    step = 'start from the card';
    await page.click(button('start'), 'start');
    await page.waitFor(live('外部进程：ready'), 'ready again');
    const first = await pid();

    step = 'restart from the card';
    await page.waitFor(`${button('restart')}?.disabled === false`, 'the restart button');
    await page.click(button('restart'), 'restart');
    // The buttons go while it is stopping (nothing to press then): wait for them to come back with the new process.
    await page.waitFor(`${button('restart')}?.disabled === false && ${live('外部进程：ready')}`, 'ready after the restart');
    assert.notEqual(await pid(), first, 'a new process');

    step = 'a stop made elsewhere reaches the open card';
    await app.api('POST', '/api/plugins/card-demo/stop', {});
    await page.waitFor(live('外部进程：stopped'), 'the stream frame, without a reload');

    step = 'the automatic restart switch is saved';
    await page.click(`${card}.querySelector('[data-plugin-switch="autoRestart"]')`, 'the switch');
    await page.waitFor(`${card}.querySelector('[data-plugin-switch="autoRestart"]').checked`, 'switched on');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'home', 'plugins.json'), 'utf8')).autoRestart, ['card-demo']);

    const problems = browser.problems();
    assert.deepEqual(problems.exceptions, [], 'no uncaught exception');
    assert.deepEqual(problems.console, [], 'no console error');
  } catch (error) {
    throw new Error(`${step}: ${(error as Error).message}`, { cause: error });
  } finally {
    await browser?.close();
    await app.close();
  }
});
