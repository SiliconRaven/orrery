// The presence dot on a member's orbit (ui.js avatarEl, style.css .avatar-orbit) in a real browser: in the header's
// stack of avatars and in the member list, at 1440 and 375 px and in all three themes, every dot lies inside its orbit's
// box, is what the pointer finds at its centre (not clipped by an overflow, not covered by the next avatar), and does not
// touch the app badge. A test Hub with mock members registered as Claude (so their avatar is the app icon with a badge),
// the real page in a headless installed browser (test/browser.ts). Skipped when no supported browser is installed,
// unless ORRERY_REQUIRE_BROWSER=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { fixtureNativeMock, startTestHub, tempDir, TEST_TOKEN } from './helpers.ts';

const found = findBrowser();
const required = process.env.ORRERY_REQUIRE_BROWSER === '1';
const skip = found.path === null && !required ? `no supported browser: ${found.reason}` : false;

// The header's toggle lets clicks through its children (pointer-events: none), so the check turns hit testing back on.
const CHECK = `((scope) => { const s = document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '.avatar-orbit, .avatar-orbit * { pointer-events: auto !important; }' }));
  const out = [...document.querySelectorAll(scope + ' .avatar-orbit')].map((orbit) => {
  const o = orbit.getBoundingClientRect(), dot = orbit.querySelector('.presence-dot'), d = dot.getBoundingClientRect();
  const mark = orbit.querySelector('.avatar-mark')?.getBoundingClientRect();
  const hit = document.elementFromPoint(d.left + d.width / 2, d.top + d.height / 2);
  return { cls: orbit.className, title: orbit.title, w: d.width, hit: hit && (hit.tagName + '.' + hit.className + ' in ' + hit.parentElement?.className),
    inside: d.left >= o.left - .5 && d.right <= o.right + .5 && d.top >= o.top - .5 && d.bottom <= o.bottom + .5,
    seen: hit === dot, apart: !mark || d.bottom <= mark.top || d.left >= mark.right || d.right <= mark.left || d.top >= mark.bottom };
  });
  s.remove();
  return out;
})`;

test('presence dot: inside its orbit, visible and clear of the app badge, in the header stack and the member list', { skip, timeout: 180_000 }, async () => {
  assert.ok(found.path, `ORRERY_REQUIRE_BROWSER=1 but ${found.path === null ? found.reason : ''}`);
  const dir = tempDir();
  const hub = await startTestHub({ dir, nativeAdapters: { mock: fixtureNativeMock(dir), claude: { ...fixtureNativeMock(dir), harness: 'claude' } } });
  let browser: Browser | null = null;
  try {
    await hub.api('POST', '/api/clusters', { name: 'orbit', members: [
      ...['opus', 'sonnet'].map((name, i) => ({ harness: 'claude', mode: 'native', sessionId: `s${i + 1}`, name })),
      ...['bot', 'tester', 'helper'].map((name) => ({ harness: 'mock', mode: 'native', name, projectPath: '/work' }))] });
    browser = await launchBrowser(found.path, { redact: [TEST_TOKEN] });
    const page = browser.page;
    await page.navigate(`${hub.url}/#token=${TEST_TOKEN}`);
    const item = `[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'orbit')`;
    for (const width of [1440, 375]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 812 : 900, deviceScaleFactor: 1, mobile: false });
      for (const theme of ['light', 'dark', 'orrery']) {
        await page.evaluate(`localStorage.setItem('orrery.theme', '${theme}'); localStorage.setItem('orrery.panelOpen', '0'); location.reload(); true`);
        await new Promise((r) => setTimeout(r, 300));
        await page.waitFor(`document.readyState === 'complete' && ${item}`, 'the cluster');
        await page.evaluate(`${item}.click()`);
        await page.waitFor(`document.querySelectorAll('#members-toggle .avatar-orbit').length === 5`, 'the header stack');
        const where = `${width} px ${theme}`;
        assert.equal(await page.evaluate<string>(`document.documentElement.dataset.theme`), theme, where);
        const stack = await page.evaluate<any[]>(`${CHECK}('#members-toggle')`);
        for (const a of stack) {
          assert.ok(a.inside && a.seen && a.apart, `${where}, header ${a.title}: ${JSON.stringify(a)}`);
          assert.equal(a.w, 7, `${where}: a 7 px dot on a 22 px avatar`);
        }
        assert.ok(stack.every((a) => /^avatar-orbit sm presence-(idle|busy|offline)$/.test(a.cls)), JSON.stringify(stack));
        await page.evaluate(`document.getElementById('members-toggle').click()`);
        await page.waitFor(`document.querySelectorAll('#manage-list .manage-row .avatar-orbit').length === 5 && document.querySelector('#manage-list .manage-row').offsetHeight > 0`, 'the member list');
        for (const a of await page.evaluate<any[]>(`${CHECK}('#manage-list')`)) {
          assert.ok(a.inside && a.seen && a.apart, `${where}, member list ${a.title}: ${JSON.stringify(a)}`);
        }
      }
    }
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await hub.close();
  }
});
