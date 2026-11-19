// The member panel's rows lay out by the panel's real width (docs/cluster-members.md「群员列表的每一行」): on a touch
// screen with the panel at its 280 px minimum the action icons move to their own line instead of crushing the name.
// A test Hub with mock members, the real page in a headless installed browser (test/browser.ts), touch emulated over
// DevTools. Skipped when no supported browser is installed, unless ORRERY_REQUIRE_BROWSER=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { fixtureNativeMock, startTestHub, tempDir, TEST_TOKEN, waitFor } from './helpers.ts';

const found = findBrowser();
const required = process.env.ORRERY_REQUIRE_BROWSER === '1';
const skip = found.path === null && !required ? `no supported browser: ${found.reason}` : false;
const LONG = 'ReviewerForBackendServices';   // 26 characters, no break opportunity

test('member list layout: at 280 px on a touch screen names keep their width and the 44 px icons wrap; at 360 px with a mouse they sit beside the name; two members of one app have different marks', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, `ORRERY_REQUIRE_BROWSER=1 but ${found.path === null ? found.reason : ''}`);
  const dir = tempDir();
  // Two members of one known app (a mock registered as 'claude'): their default avatar is Claude's icon.
  const hub = await startTestHub({ dir, nativeAdapters: { mock: fixtureNativeMock(dir), claude: { ...fixtureNativeMock(dir), harness: 'claude' } } });
  let browser: Browser | null = null;
  try {
    await hub.api('POST', '/api/clusters', { name: 'narrow', members: [...['bot', LONG, '前端评审员小王'].map((name) => ({ harness: 'mock', mode: 'native', name, projectPath: '/work' })),
      { harness: 'claude', mode: 'native', sessionId: 's1', name: 'opus' }, { harness: 'claude', mode: 'native', sessionId: 's2', name: 'sonnet' }] });
    browser = await launchBrowser(found.path, { redact: [TEST_TOKEN] });
    const page = browser.page;
    // Tall enough for all five cards: a list scroll bar would take 15 px from every row the checks below measure.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false });
    await page.navigate(`${hub.url}/#token=${TEST_TOKEN}`);
    const open = async (panelWidth: number, touch: boolean) => {
      await page.send('Emulation.setTouchEmulationEnabled', touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      await page.evaluate(`localStorage.setItem('orrery.width.panel', '${panelWidth}'); localStorage.setItem('orrery.panelOpen', '1'); location.reload(); true`);
      await new Promise((r) => setTimeout(r, 300));
      await page.waitFor(`document.readyState === 'complete' && [...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'narrow')`, 'the cluster');
      await page.evaluate(`[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'narrow').click()`);
      await page.waitFor(`document.querySelectorAll('#manage-list .manage-row').length === 5 && document.querySelector('#manage-list .manage-row').offsetHeight > 0`, 'the member list');
      return page.evaluate<any>(`(() => {
        const list = document.getElementById('manage-list');
        return {
          coarse: matchMedia('(pointer: coarse)').matches,
          panel: Math.round(document.getElementById('member-panel').getBoundingClientRect().width),
          overflow: list.scrollWidth > list.clientWidth || document.documentElement.scrollWidth > document.documentElement.clientWidth,
          rows: [...list.querySelectorAll('.manage-row')].map((r) => {
            const name = r.querySelector('.manage-person b');
            const open = r.querySelector('.member-open').getBoundingClientRect();
            const buttons = [...r.querySelectorAll('.member-action')].map((b) => b.offsetWidth + 'x' + b.offsetHeight);
            return { name: name.textContent, nameWidth: name.getBoundingClientRect().width,
              room: r.querySelector('.manage-person').getBoundingClientRect().width, oneLine: name.getBoundingClientRect().height < 28,
              actionsBeside: r.querySelector('.member-actions').getBoundingClientRect().top < open.bottom - 1, buttons: [...new Set(buttons)],
              appBadgeBoxes: r.querySelector('.member-app').getClientRects().length, badgeIcon: Boolean(r.querySelector('.member-app .app-icon')),
              avatar: r.querySelector('.avatar').className, mark: r.querySelector('.avatar-mark')?.textContent ?? null,
              markColor: r.querySelector('.avatar-mark') ? getComputedStyle(r.querySelector('.avatar-mark')).backgroundColor : null,
              markInside: (() => { const m = r.querySelector('.avatar-mark')?.getBoundingClientRect(), c = r.getBoundingClientRect();
                return !m || (m.left >= c.left && m.right <= c.right && m.top >= c.top && m.bottom <= c.bottom); })(),
              title: r.querySelector('.avatar-orbit').title, faceTitle: r.querySelector('.avatar').title,
              gap: Math.round(r.querySelector('.member-details').getBoundingClientRect().top - r.querySelector('.manage-head').getBoundingClientRect().bottom) };
          }),
        };
      })()`);
    };

    // The reviewer's case: touch screen, panel dragged to its minimum.
    const narrow = await open(280, true);
    assert.equal(narrow.coarse, true, 'touch emulation makes (pointer: coarse) match');
    assert.equal(narrow.panel, 280);
    assert.equal(narrow.overflow, false, 'no horizontal scrolling');
    for (const row of narrow.rows) {
      assert.deepEqual(row.buttons, ['44x44'], `${row.name}: 44 px touch targets`);
      assert.equal(row.actionsBeside, false, `${row.name}: the icons moved under the name`);
      assert.ok(row.room >= 150, `${row.name}: the name line keeps its width (${row.room} px; the bug left 18 px)`);
      assert.equal(row.appBadgeBoxes, 1, `${row.name}: the app badge is not broken across lines`);
    }
    for (const row of narrow.rows.filter((r: any) => r.name !== LONG)) assert.ok(row.oneLine, `${row.name}: on one line`);
    assert.ok(narrow.rows.find((r: any) => r.name === LONG).nameWidth >= 150, 'the long name gets the full line');

    // The default: a mouse and the 360 px panel keep the compact row, icons beside short names.
    const wide = await open(360, false);
    assert.equal(wide.coarse, false);
    assert.equal(wide.overflow, false);
    for (const row of wide.rows) assert.deepEqual(row.buttons, ['30x30'], row.name);
    assert.ok(wide.rows.filter((r: any) => r.name !== LONG).every((r: any) => r.actionsBeside && r.oneLine), JSON.stringify(wide.rows));

    // Default avatars: the app's icon with each member's own mark, inside the card at both widths; the small app icon
    // beside the name only where the avatar is not already it (mock has no icon: the initial tile and the badge stay).
    for (const rows of [narrow.rows, wide.rows]) {
      const [opus, sonnet] = ['opus', 'sonnet'].map((n) => rows.find((r: any) => r.name === n));
      for (const r of [opus, sonnet]) {
        assert.match(r.avatar, /\bapp\b/, `${r.name}: the app's icon`);
        assert.equal(r.badgeIcon, false, `${r.name}: not repeated beside the name`);
        assert.match(r.title, new RegExp(`^${r.name} · Claude · (空闲|离线|投递通道占用)$`), `${r.name}: the avatar's orbit names the member, app and state`);
        assert.equal(r.faceTitle, '', `${r.name}: one tooltip, on the orbit`);
        assert.equal(r.markInside, true, `${r.name}: the mark stays inside the card`);
      }
      if (/\bbadge\b/.test(opus.avatar)) {
        assert.deepEqual([opus.mark, sonnet.mark], ['O', 'S'], 'different letters');
        assert.notEqual(opus.markColor, sonnet.markColor, 'and different colours');
      }
      for (const r of rows.filter((r: any) => r.name !== 'opus' && r.name !== 'sonnet')) {
        assert.doesNotMatch(r.avatar, /\bapp\b/, r.name);
        assert.equal(r.badgeIcon, true, `${r.name}: the app badge stays`);
      }
    }
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await hub.close();
  }
});

// WCAG contrast of every text and icon in the member list against what is really behind it (computed colours).
const CONTRAST = `(() => {
  const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number), k = c.startsWith('color(') ? 255 : 1; return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m[3] ?? 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.a > 0) { stack.push(c); if (c.a === 1) break; } } let out = { r: 255, g: 255, b: 255, a: 1 }; for (const c of stack.reverse()) out = blend(c, out); return out; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const low = [];
  const check = (el, prop, min) => {
    const bg = bgOf(el);
    const r = ratio(blend(parse(getComputedStyle(el)[prop]), bg), bg);
    if (r < min) low.push(el.className.baseVal ?? el.className + ' ' + r.toFixed(2));
  };
  const scope = [...document.querySelectorAll('#manage-list .manage-row *, #members-meta, #members-view .panel-note')]
    .filter((el) => !el.closest('.sr-only, .avatar, .member-action') && el.getClientRects().length);
  for (const el of scope) if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) check(el, 'color', 4.5);
  for (const el of document.querySelectorAll('#manage-list svg.ico')) check(el, 'stroke', 3);
  return { checked: scope.length, low };
})()`;

test('member list: each long conversation warns in its own row; contrast holds in light and dark; removing asks in the dialog, and cancel sends nothing', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, `ORRERY_REQUIRE_BROWSER=1 but ${found.path === null ? found.reason : ''}`);
  const hub = await startTestHub();
  let browser: Browser | null = null;
  try {
    await hub.cluster('alerts', ['a1', 'a2', 'a3', 'a4']);
    browser = await launchBrowser(found.path, { redact: [TEST_TOKEN] });
    const page = browser.page;
    // Long conversations for a1 and a3 (the Hub computes `alert` from real token counts; the page only shows it), and a
    // record of the DELETE requests the page sends.
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const real = window.fetch.bind(window), names = {};
      window.__deletes = [];
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (init?.method === 'DELETE') window.__deletes.push(url);
        const res = await real(input, init);
        if (url.startsWith('/api/state')) { const st = await res.clone().json(); for (const m of st.members) names[m.id] = m.name; }
        if (!url.startsWith('/api/usage?')) return res;
        const u = await res.json();
        for (const row of u.members) if (names[row.memberId] === 'a1' || names[row.memberId] === 'a3') row.alert = { turnTokens: null, conversationTokens: 1085000000 };
        // A used-up quota: the red chip is the lowest-contrast text the list can show.
        u.quotas = [{ harness: 'mock', supported: true, source: 'x', snapshot: { windows: [{ id: 'h5', label: '5 小时', usedPercent: 100,
          resetsAt: new Date(Date.now() + 3600000).toISOString() }], observedAt: new Date().toISOString(), source: 'x' } }];
        return new Response(JSON.stringify(u), { status: 200, headers: { 'content-type': 'application/json' } });
      };
    })();` });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate(`${hub.url}/#token=${TEST_TOKEN}`);
    const open = async (dark: boolean) => {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
      await page.evaluate(`localStorage.setItem('orrery.width.panel', '360'); localStorage.setItem('orrery.panelOpen', '1'); location.reload(); true`);
      await new Promise((r) => setTimeout(r, 300));
      await page.waitFor(`document.readyState === 'complete' && [...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'alerts')`, 'the cluster');
      await page.evaluate(`[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'alerts').click()`);
      await page.waitFor(`document.querySelectorAll('#manage-list .member-length-alert').length === 2`, 'the warnings');
    };
    const rowOf = (name: string) => `[...document.querySelectorAll('#manage-list .manage-row')].find((r) => r.querySelector('.manage-person b').textContent === '${name}')`;

    await open(false);
    const warned = await page.evaluate<any>(`({
      rows: [...document.querySelectorAll('#manage-list .manage-row')].map((r) => [r.querySelector('.manage-person b').textContent, r.querySelectorAll('.member-length-alert').length]),
      outside: [...document.querySelectorAll('#members-view .member-length-alert')].filter((a) => !a.closest('.manage-row')).length,
      text: document.querySelector('#manage-list .member-length-alert').textContent,
      exhausted: document.querySelectorAll('#manage-list .member-quota.quota-exhausted').length,
    })`);
    assert.equal(warned.exhausted, 4, 'the used-up quota chip is on every row (it is checked for contrast below)');
    assert.deepEqual(warned.rows, [['a1', 1], ['a2', 0], ['a3', 1], ['a4', 0]], 'only the members it is about, each in its own row');
    assert.equal(warned.outside, 0, 'no box after the list');
    assert.equal(warned.text, '对话已很长（单轮 未知 / 合计 1085M），建议在应用里开新对话或压缩。');
    const light = await page.evaluate<any>(CONTRAST);
    assert.ok(light.checked > 20, `checked ${light.checked} elements`);
    assert.deepEqual(light.low, [], 'light: text 4.5:1, icons 3:1');

    // Remove a2: the page's own confirm dialog names it; cancel sends nothing and goes back to its remove button.
    await page.click(`${rowOf('a2')}.querySelector('.member-action.danger')`, 'a2 remove');
    await page.waitFor(`document.querySelector('dialog.ask[open]')`, 'the confirm dialog');
    const ask = await page.evaluate<any>(`({ title: document.getElementById('ask-title').textContent, ok: document.querySelector('dialog.ask button[value=confirm]').textContent,
      danger: document.querySelector('dialog.ask button[value=confirm]').classList.contains('danger'), focus: document.activeElement.textContent })`);
    assert.deepEqual(ask, { title: '将“a2”移出集群？', ok: '移出集群', danger: true, focus: '取消' });
    await page.click(`document.querySelector('dialog.ask button[value=cancel]')`, 'cancel');
    await page.waitFor(`!document.querySelector('dialog.ask')`, 'the dialog to close');
    assert.equal(await page.evaluate(`document.activeElement.getAttribute('aria-label')`), '移出集群：a2');
    assert.deepEqual(await page.evaluate(`window.__deletes`), []);
    // Confirm: one DELETE; the row goes and focus moves to the next member.
    await page.click(`${rowOf('a2')}.querySelector('.member-action.danger')`, 'a2 remove');
    await page.waitFor(`document.querySelector('dialog.ask[open]')`, 'the confirm dialog');
    await page.click(`document.querySelector('dialog.ask button[value=confirm]')`, 'confirm');
    await page.waitFor(`document.querySelectorAll('#manage-list .manage-row').length === 3`, 'the row to go');
    assert.equal((await page.evaluate<string[]>(`window.__deletes`)).length, 1);
    await page.waitFor(`document.activeElement?.title === '打开 a3 的成员页'`, 'focus on the next member');

    await open(true);
    const dark = await page.evaluate<any>(CONTRAST);
    assert.deepEqual(dark.low, [], 'dark: text 4.5:1, icons 3:1');
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await hub.close();
  }
});

test('default avatars: same-prefix members of one app differ in the header stack, the @ picker and the list; a removed member keeps its old avatar', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, `ORRERY_REQUIRE_BROWSER=1 but ${found.path === null ? found.reason : ''}`);
  const dir = tempDir();
  // A mock registered as 'claude' (attached and new conversations), so all of these share Claude's icon.
  const hub = await startTestHub({ dir, nativeAdapters: { mock: fixtureNativeMock(dir), claude: { ...fixtureNativeMock(dir), harness: 'claude' } } });
  let browser: Browser | null = null;
  try {
    const iso = (name: string) => ({ harness: 'claude', mode: 'native', name, projectPath: '/work' });
    const { cluster, members } = await hub.api('POST', '/api/clusters', { name: 'same', members: [
      { harness: 'claude', mode: 'native', sessionId: 's1', name: 'claude-2' }, { harness: 'claude', mode: 'native', sessionId: 's2', name: 'claude-opus' },
      iso('claude-opus-2'), iso('前端评审'), iso('前端开发'), iso('Retired')] });
    const retired = members.find((m: any) => m.name === 'Retired');
    hub.hub.sendFromMember(retired.id, '我先走了');
    await hub.api('DELETE', `/api/clusters/${cluster.id}/members/${retired.id}`, {});
    browser = await launchBrowser(found.path, { redact: [TEST_TOKEN] });
    const page = browser.page;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false });
    await page.navigate(`${hub.url}/#token=${TEST_TOKEN}`);
    await page.evaluate(`localStorage.setItem('orrery.width.panel', '360'); localStorage.setItem('orrery.panelOpen', '1'); location.reload(); true`);
    await new Promise((r) => setTimeout(r, 300));
    await page.waitFor(`document.readyState === 'complete' && [...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'same')`, 'the cluster');
    await page.evaluate(`[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'same').click()`);
    await page.waitFor(`document.querySelectorAll('#manage-list .manage-row').length === 5 && document.querySelectorAll('#members-toggle .avatar').length === 5`, 'the list and the stack');
    await page.evaluate(`document.getElementById('composer-input').focus(); true`);
    await page.send('Input.insertText', { text: '@' });
    await page.waitFor(`document.querySelectorAll('.mention-menu li').length >= 5`, 'the @ picker');
    // The chat history loads after the member list: wait for the removed member's message before reading its avatar.
    await page.waitFor(`[...document.querySelectorAll('#messages article.msg .who')].some((w) => w.textContent.startsWith('Retired'))`, 'the removed member\x27s message');
    const seen = await page.evaluate<any>(`(() => {
      const mark = (a) => ({ app: a.classList.contains('app'), label: a.querySelector('.avatar-mark')?.textContent ?? null,
        hidden: a.querySelector('.avatar-mark')?.getAttribute('aria-hidden') ?? null,
        color: a.querySelector('.avatar-mark') ? getComputedStyle(a.querySelector('.avatar-mark')).backgroundColor : null,
        // On an orbit (status dot) the orbit carries the tooltip and, in the stack, the accessible name.
        title: (a.closest('.avatar-orbit') ?? a).title, name: (a.closest('.avatar-orbit') ?? a).getAttribute('aria-label'), box: a.querySelector('.avatar-mark')?.getBoundingClientRect().toJSON() ?? null });
      const retired = [...document.querySelectorAll('#messages article.msg')].find((m) => m.querySelector('.who')?.textContent.startsWith('Retired'));
      return {
        stack: [...document.querySelectorAll('#members-toggle .avatar')].map(mark),
        picker: [...document.querySelectorAll('.mention-menu li')].map((li) => ({ text: li.textContent, ...mark(li.querySelector('.avatar')) })),
        list: [...document.querySelectorAll('#manage-list .manage-row')].map((r) => ({ text: r.querySelector('.manage-person b').textContent, ...mark(r.querySelector('.avatar')) })),
        retired: retired ? { cls: retired.querySelector('.avatar').className, img: Boolean(retired.querySelector('.avatar img')), text: retired.querySelector('.avatar').textContent } : null,
      };
    })()`);
    const labels = { 'claude-2': '2', 'claude-opus': 'O', 'claude-opus-2': 'P', '前端评审': '评', '前端开发': '开' };
    // The stack: no names beside it, so each avatar is named; labels and colours all differ; badges never overlap.
    assert.deepEqual(seen.stack.map((a: any) => [a.name, a.label, a.hidden]), Object.entries(labels).map(([n, l]) => [`${n}，空闲`, l, 'true']), 'named with the state, which the dot shows');
    assert.equal(new Set(seen.stack.map((a: any) => a.color)).size, 5, `five colours: ${seen.stack.map((a: any) => a.color)}`);
    for (let i = 1; i < seen.stack.length; i++) assert.ok(seen.stack[i].box.left >= seen.stack[i - 1].box.right, `badge ${i} clear of badge ${i - 1}`);
    // The picker and the list print the name beside the avatar: the same labels, the name only as the tooltip.
    for (const where of [seen.picker.filter((p: any) => p.app), seen.list]) {
      assert.deepEqual(where.map((a: any) => [a.label, a.name]), Object.values(labels).map((l) => [l, null]));
      assert.deepEqual(where.map((a: any) => a.title.split(' · ')[0]), Object.keys(labels), 'the tooltip names the member');
    }
    // Retired had no avatar: its old message keeps the initial tile, not the app's icon.
    assert.deepEqual(seen.retired, { cls: 'avatar ', img: false, text: 'R' });
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await hub.close();
  }
});
