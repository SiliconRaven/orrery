// A tool plugin's card in the real page (headless, test/browser.ts; docs/external-plugins.md「群员工具」): the open
// details name every cluster the tools are offered in, and follow a restart made elsewhere that changed the grant,
// while an unsaved input on the same card keeps its value and focus. Uses the shared profile slots, like the other
// browser tests; a supported browser must be installed unless ORRERY_REQUIRE_BROWSER=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { REPO_ROOT } from '../src/main.ts';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { startTestHub, tempDir, TEST_TOKEN } from './helpers.ts';

const found = findBrowser();
const skip = found.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? `no supported browser: ${found.reason}` : false;
const OLD = ['甲组', '乙组', '丙组', '丁组', '戊组', '己组'];

test('browser: the open tools card names every cluster and follows a restart with a changed grant', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, 'ORRERY_REQUIRE_BROWSER=1 but no supported browser');
  const dir = tempDir();
  mkdirSync(join(dir, 'home'));
  const seed = new Store(join(dir, 'test.db'));
  for (const name of [...OLD, '新群']) seed.insertCluster({ id: `id-${name}`, name, category: '', createdAt: '2026-01-01' }, []);
  seed.close();
  const folder = join(dir, 'plugins', 'tool-demo');
  cpSync(join(REPO_ROOT, 'test', 'fixtures', 'tool-demo'), folder, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(folder, 'orrery-plugin.json'), 'utf8'));
  manifest.permissions.push('messages.send');
  writeFileSync(join(folder, 'orrery-plugin.json'), JSON.stringify(manifest));
  const grant = (clusters: string[]) => writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: [{
    manifest: join(folder, 'orrery-plugin.json'), permissions: ['tools.provide', 'messages.send'], tools: ['echo'],
    clusterIds: clusters.map((name) => `id-${name}`), writeClusterIds: ['id-甲组'] }] }));
  grant(OLD);
  const app = await startTestHub({ dir });
  let browser: Browser | null = null;
  let step = 'setup';
  try {
    browser = await launchBrowser(found.path!, { redact: [TEST_TOKEN] });
    const page = browser.page;
    const area = `document.querySelector('[data-plugin-grant="tool-demo"]')`;
    const input = `document.querySelector('#plugin-details-tool-demo input[type=number]')`;

    step = 'open the card details';
    await page.navigate(`${app.url}/#token=${TEST_TOKEN}`);
    await page.waitFor(`document.getElementById('open-settings')`, 'the settings button');
    await page.click(`document.getElementById('open-settings')`, 'settings');
    await page.click(`document.getElementById('settings-tab-plugins')`, 'the plugins tab');
    await page.waitFor(`document.querySelector('[data-plugin-live="tool-demo"]')?.textContent.includes('外部进程：ready')`, 'the card, ready');
    await page.click(`document.querySelector('[data-plugin-details="tool-demo"]')`, 'the details');
    for (const name of OLD) assert.ok(await page.evaluate(`${area}.textContent.includes('「${name}」')`), `${name} is named`);

    step = 'an unsaved edit on the same card';
    await page.type(input, '7', 'the per-minute limit');
    const typed = await page.evaluate<string>(`${input}.value`);

    step = 'restart elsewhere with one other cluster';
    grant(['新群']);
    await app.api('POST', '/api/plugins/tool-demo/restart', {});
    await page.waitFor(`${area}?.textContent.includes('「新群」')`, 'the new grant on the open card');
    for (const name of OLD) assert.equal(await page.evaluate(`${area}.textContent.includes('「${name}」')`), false, `${name} is gone`);
    assert.equal(await page.evaluate(`${input}.value`), typed, 'the unsaved input keeps its value');
    assert.equal(await page.evaluate(`document.activeElement === ${input}`), true, 'and the focus');
    assert.equal(await page.evaluate(`document.getElementById('plugin-details-tool-demo').hidden`), false, 'the details stay open');

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
