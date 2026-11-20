// Electron check for 界面语言 (docs/desktop.md): the language switched from the collaboration page's settings and from
// the desktop settings, back and forth, takes effect at once everywhere (tab bar, "+" panel, settings view,
// collaboration page) without loading any page again, keeps the page's draft, is saved, and is the language of the
// next start. Only the bound Hub page's main frame with zh or en is listened to. Run in desktop/: `npm run test:language`.
// The shell runs for real against a real test Hub (temporary ORRERY_HOME / ORRERY_DB, a free port other than 4317,
// the demo mock harness), with the recording fake of the Win32 layer. Its windows are shown inactive and off-screen:
// nothing comes to the front. ORRERY_LANGUAGE_SHOTS=<folder> also saves screenshots (capturePage) there.
import { BrowserWindow, app, ipcMain } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runEnsure, startShell } from '../shell.mjs';
import { createFakeFfi } from './fake-ffi.mjs';
import { checkTempDir } from './temp-dir.mjs';

const dir = checkTempDir('orrery-desktop-language-');
app.setPath('userData', join(dir, 'shell'));
const SHOTS = process.env.ORRERY_LANGUAGE_SHOTS || null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
};
const until = async (cond, ms = 8000) => { const end = Date.now() + ms; while (!(await cond()) && Date.now() < end) await sleep(60); return cond(); };
const js = (wc, code) => wc.executeJavaScript(code).catch((e) => `error: ${e.message}`);
app.on('window-all-closed', () => { /* the restart below closes the first shell on purpose */ });
// Never in front of the user: every window the shell shows is shown inactive, off-screen.
BrowserWindow.prototype.show = function show() {
  const b = this.getBounds();
  if (b.x > -3000) this.setPosition(-4000 - b.width, -4000 - b.height);
  this.showInactive();
};

const freePort = () => new Promise((ok) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port === 4317 ? freePort() : port)); });
});
const API_TOKEN = 'language-check-token-0123456789abcdefghij';
// Nothing of this machine is read (no Start Menu, no aliases) and nothing can be started.
const sources = () => ({ localAppData: '', readAlias: () => null, readText: () => null, isFile: () => false, shortcuts: () => [], lstat: () => null });
const launchTarget = () => ({ ok: false, reason: 'language check: nothing is started' });

async function shot(wc, name) {
  if (!SHOTS) return;
  await sleep(400);   // the last paint
  try { writeFileSync(join(SHOTS, `${name}.png`), (await wc.capturePage()).toPNG()); }
  catch (e) { console.log(`       (no screenshot ${name}: ${e.message})`); }
}

/** What every page shows now: its language, and for the collaboration page its address, a draft and its load count. */
async function snapshot(h) {
  const lang = (wc) => js(wc, 'document.documentElement.lang');
  let saved = null;   // nothing saved yet: the shell starts in Chinese
  try { saved = JSON.parse(readFileSync(join(app.getPath('userData'), 'desktop-state.json'), 'utf8')).language; } catch { /* not written yet */ }
  return {
    saved,
    tabs: await lang(h.tabs), strip: await lang(h.strips), settings: await lang(h.settingsPage),
    page: await lang(h.collab), pageUrl: new URL(h.collab.getURL()).searchParams.get('uiLang'),
    select: await js(h.collab, "document.getElementById('ui-language').value"),
    settingsSelect: await js(h.settingsPage, "document.getElementById('language').value"),
    gear: await js(h.collab, "document.getElementById('open-settings').title || document.getElementById('open-settings').getAttribute('aria-label')"),
    tabName: await js(h.tabs, "document.querySelector('.tab .pick').getAttribute('aria-label')"),
    draft: await js(h.collab, "document.getElementById('composer-input').value"),
    marker: await js(h.collab, 'window.__notReloaded === true'),
  };
}
const expectAll = (s, lang) => {
  const html = lang === 'en' ? 'en' : 'zh-CN';
  return s.saved === lang && s.tabs === html && s.strip === html && s.settings === html && s.page === html && s.pageUrl === lang
    && s.select === lang && s.settingsSelect === lang && s.tabName === (lang === 'en' ? 'Collaboration' : '协作页');
};

app.whenReady().then(async () => {
  console.log(`orrery desktop language checks, Electron ${process.versions.electron}`);
  const port = await freePort();
  // Everything of this Hub in the check's own temporary folder, the Hub registry too: never the user's own home,
  // database, port or registry (an inherited or default ORRERY_REGISTRY would be the user's).
  const env = { ...process.env, ORRERY_HOME: join(dir, 'home'), ORRERY_DB: join(dir, 'hub.db'), ORRERY_PORT: String(port),
    ORRERY_REGISTRY: join(dir, 'registry'), ORRERY_API_TOKEN: API_TOKEN, ORRERY_MOCK: '1', ORRERY_UPDATE_CHECKS: '0',
    ORRERY_SKILLS_DIR: join(dir, 'skills') };
  let hubOrigin = null;
  try {
    const ensured = await runEnsure({ env });
    check('origin' in ensured, 'a real test Hub started on a free port', JSON.stringify(ensured));
    hubOrigin = ensured.origin;
    const auth = { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' };
    const created = await (await fetch(`${hubOrigin}/api/clusters`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'demo', members: [
      { harness: 'mock', sessionId: 'mock-session-1', name: 'alice' }, { harness: 'mock', sessionId: 'mock-session-2', name: 'bob' }] }) })).json();
    const clusterId = created.cluster.id;
    const alice = created.members.find((m) => m.name === 'alice').id;
    // A cancelled task, which can be deleted for good (its confirmation is checked below).
    const collab = (body) => fetch(`${hubOrigin}/api/clusters/${clusterId}/collaboration`, { method: 'POST', headers: auth,
      body: JSON.stringify({ ...body, operationId: crypto.randomUUID() }) }).then((r) => r.json());
    const made = await collab({ action: 'task.create', title: 'Old plan', scope: 'Do the thing', acceptance: 'It is done' });
    const cancelled = await collab({ action: 'task.cancel', taskId: made.task.id, expectedRevision: made.task.revision, closeReason: 'not_planned', reason: 'not needed' });
    check(cancelled.task?.status === 'cancelled', 'a cancelled task to delete', JSON.stringify(cancelled).slice(0, 200));
    // Enough lines on alice's member page to scroll it.
    for (let i = 1; i <= 30; i++) {
      await fetch(`${hubOrigin}/api/clusters/${clusterId}/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ body: `@alice note ${i}` }) });
    }

    const ffi = createFakeFfi([]);
    let h = startShell({ ffi, ensure: async () => ensured, sources, launchTarget });
    const ready = async (shell) => until(async () => (await js(shell.collab, "document.getElementById('cluster-list')?.childElementCount > 0 && !!document.getElementById('ui-language')")) === true
      && (await js(shell.tabs, "document.querySelectorAll('.tab').length")) > 0, 20_000);
    check(await ready(h), 'the shell and the collaboration page are up');
    let loads = 0;
    h.collab.on('did-finish-load', () => { loads++; });
    // An error thrown in the page fails the check (a draw that throws stops halfway and would hide what is checked).
    h.collab.on('console-message', (e) => { if (e.level === 'error') check(false, 'no error in the collaboration page', String(e.message).slice(0, 300)); });
    await js(h.collab, "window.__notReloaded = true; document.getElementById('composer-input').value = 'unsent draft'; true");
    // An attachment waiting to be sent (uploaded at once, sent with the next message).
    await js(h.collab, `(() => { const input = document.getElementById('composer-file'); const dt = new DataTransfer();
      dt.items.add(new File(['hello'], 'note.txt', { type: 'text/plain' })); input.files = dt.files; input.dispatchEvent(new Event('change')); return true; })()`);
    const attachments = () => js(h.collab, "document.getElementById('composer-files').childElementCount");
    check(await until(async () => (await attachments()) === 1), 'an attachment waits in the composer');
    // The page's own settings dialog stays open on 外观 through every switch (an open dialog is kept, not reloaded).
    await js(h.collab, "document.getElementById('open-settings').click(); true");
    const settingsOpen = async () => {
      ipcMain.emit('tabs:settings', { sender: h.tabs, senderFrame: h.tabs.mainFrame }, 40);
      return until(() => h.settings !== null && h.settingsWin.isVisible(), 3000);
    };
    check(await settingsOpen(), 'the desktop settings view opens (inactive, off-screen)');
    let s = await snapshot(h);
    check(expectAll({ ...s, saved: 'zh' }, 'zh'), 'starts in Chinese everywhere', JSON.stringify(s));
    await shot(h.collab, '1-page-zh');

    console.log('\n[language] back and forth between the two entries, three times');
    for (let round = 1; round <= 3; round++) {
      // The collaboration page's own select (设置 → 外观 → 界面语言), as a user's change.
      await js(h.collab, "(() => { const s = document.getElementById('ui-language'); s.value = 'en'; s.dispatchEvent(new Event('change')); return true; })()");
      check(await until(async () => expectAll(await snapshot(h), 'en')), `round ${round}: the page's select → English: the page, tab bar, + panel and settings view all switch, and it is saved`,
        JSON.stringify(await snapshot(h)));
      if (round === 1) { await shot(h.collab, '2-page-en-from-page'); await shot(h.settingsPage, '2-desktop-settings-en'); await shot(h.tabs, '2-tabbar-en'); }
      // The desktop settings view's select: its real IPC, from the settings page.
      await js(h.settingsPage, "window.orrery.language('zh'); true");
      check(await until(async () => expectAll(await snapshot(h), 'zh')), `round ${round}: the desktop settings → 中文: everything switches back, and it is saved`,
        JSON.stringify(await snapshot(h)));
      if (round === 1) { await shot(h.collab, '3-page-zh-from-desktop'); await shot(h.settingsPage, '3-desktop-settings-zh'); }
    }
    s = await snapshot(h);
    check(loads === 0 && s.marker === true, 'the collaboration page was never loaded again', `${loads} load(s)`);
    check(await js(h.collab, "document.getElementById('settings-dialog').open") === true, 'its settings dialog is still open');
    check(s.draft === 'unsent draft', 'its unsent draft is still there', s.draft);
    check(await attachments() === 1 && /note\.txt/.test(await js(h.collab, "document.getElementById('composer-files').textContent")),
      'its attachment waiting to be sent is still there');
    await js(h.collab, "document.getElementById('settings-close').click(); true");

    console.log('\n[language] only the bound Hub page\'s main frame with zh or en is listened to');
    // The shell's own listener on the collaboration page's view, with the events Electron would emit for a subframe,
    // another origin and an invalid value (a real subframe of the Hub page cannot be made: its CSP refuses framing).
    const inPage = (url, isMainFrame) => h.collab.emit('did-navigate-in-page', {}, url, isMainFrame, 0, 0);
    inPage(`${hubOrigin}/?uiLang=en#c=1`, false);
    inPage('http://127.0.0.1:1/?uiLang=en', true);
    inPage(`http://localhost:${port}/?uiLang=en`, true);
    inPage(`${hubOrigin}/?uiLang=fr`, true);
    inPage(`${hubOrigin}/?uiLang=EN`, true);
    await sleep(300);
    s = await snapshot(h);
    check(s.saved === 'zh' && s.tabs === 'zh-CN' && s.page === 'zh-CN', 'a subframe, another origin (also localhost for 127.0.0.1) and invalid values change nothing',
      JSON.stringify(s));
    inPage(`${hubOrigin}/?uiLang=en`, true);
    check(await until(async () => (await snapshot(h)).saved === 'en' && (await snapshot(h)).tabs === 'en'), 'the same event from the main frame of the bound Hub is adopted (control)');
    inPage(`${hubOrigin}/?uiLang=zh`, true);
    check(await until(async () => (await snapshot(h)).saved === 'zh'), 'and back');
    // The page's own address with an invalid value: the page itself writes it, the shell ignores it, the page keeps its
    // language, and the next valid change from the desktop settings still reaches it (no manual repair of the address).
    await js(h.collab, "history.replaceState(history.state, '', location.pathname + '?uiLang=fr' + location.hash); true");
    await sleep(500);
    s = await snapshot(h);
    check(s.saved === 'zh' && s.tabs === 'zh-CN' && s.page === 'zh-CN', 'an invalid uiLang written by the page is ignored; the page stays Chinese', JSON.stringify(s));
    await js(h.settingsPage, "window.orrery.language('en'); true");
    check(await until(async () => expectAll(await snapshot(h), 'en')), 'after it, the desktop settings → English still switches the page (its address is valid again)',
      JSON.stringify(await snapshot(h)));
    await js(h.settingsPage, "window.orrery.language('zh'); true");
    check(await until(async () => expectAll(await snapshot(h), 'zh')), 'and back to Chinese');

    console.log('\n[language] the member page keeps unsaved edits and its scroll position');
    await js(h.collab, `location.hash = 'c=${clusterId}&m=${alice}'; true`);
    const events = () => js(h.collab, `(() => { const b = document.getElementById('member-events');
      return { n: b.childElementCount, top: b.scrollTop, room: b.scrollHeight - b.clientHeight, queued: b.textContent.includes('排队中') ? 'zh' : b.textContent.includes('Queued') ? 'en' : '?' }; })()`);
    check(await until(async () => (await events()).room > 200, 20_000), 'alice\'s member page shows enough lines to scroll', JSON.stringify(await events()));
    await js(h.collab, `(() => {
      const form = document.getElementById('member-edit');
      const name = form.querySelector('[name=name]'); name.value = 'alice-edited'; name.dispatchEvent(new Event('input', { bubbles: true }));
      const file = form.querySelector('[name=file]'); const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'face.png', { type: 'image/png' })); file.files = dt.files;
      file.dispatchEvent(new Event('change', { bubbles: true }));
      const box = document.getElementById('member-events'); box.scrollTop = Math.round((box.scrollHeight - box.clientHeight) / 2);
      return true; })()`);
    await sleep(300);
    const editor = () => js(h.collab, `(() => { const form = document.getElementById('member-edit');
      return { name: form.querySelector('[name=name]').value, files: form.querySelector('[name=file]').files.length,
        fileName: form.querySelector('[data-role=file-name]').textContent, label: form.querySelector('[data-i18n="名字"]')?.textContent }; })()`);
    const before = await events();
    for (const [lang, from] of [['en', 'desktop'], ['zh', 'page'], ['en', 'page'], ['zh', 'desktop']]) {
      if (from === 'desktop') await js(h.settingsPage, `window.orrery.language('${lang}'); true`);
      else await js(h.collab, `(() => { const s = document.getElementById('ui-language'); s.value = '${lang}'; s.dispatchEvent(new Event('change')); return true; })()`);
      check(await until(async () => expectAll(await snapshot(h), lang)), `→ ${lang} from the ${from}`);
      await sleep(300);
      const e = await editor();
      const now = await events();
      check(e.name === 'alice-edited' && e.files === 1 && e.fileName === 'face.png' && e.label === (lang === 'en' ? 'Name' : '名字'),
        `  the unsaved name and picked avatar file stay; the editor's label is ${lang}`, JSON.stringify(e));
      check(now.n === before.n && Math.abs(now.top - before.top) <= 2 && now.top < now.room - 50 && now.queued === lang,
        `  the member lines are ${lang} and stay where they were scrolled (not at the bottom)`,
        `${JSON.stringify(before)} → ${JSON.stringify(now)}`);
    }

    console.log('\n[language] open dialogs follow: a confirmation, a notice and a task form');
    await js(h.collab, `location.hash = 'c=${clusterId}'; true`);
    await sleep(500);
    const ask = () => js(h.collab, `(() => { const d = document.querySelector('dialog.ask[open]');
      return d ? { title: d.querySelector('h2')?.textContent ?? '', buttons: [...d.querySelectorAll('button')].map((b) => b.textContent) } : null; })()`);
    js(h.collab, "document.getElementById('quit').click(); true");
    check(await until(async () => (await ask())?.title === '退出 orrery？'), 'the quit confirmation is open in Chinese', JSON.stringify(await ask()));
    await js(h.settingsPage, "window.orrery.language('en'); true");
    check(await until(async () => JSON.stringify(await ask()) === JSON.stringify({ title: 'Quit Orrery?', buttons: ['Cancel', 'Quit'] })),
      'still open, now in English: title and buttons', JSON.stringify(await ask()));
    await js(h.collab, "document.querySelector('dialog.ask[open] button[value=cancel]').click(); true");
    check(await until(async () => (await ask()) === null) && !h.win.isDestroyed(), 'cancelled: nothing quit');
    await js(h.collab, "import('/ui.js').then((ui) => { ui.noticeDialog(ui.lt('恢复失败'), ui.lt('没有完成')); return true; })");
    check(await until(async () => (await ask())?.title === 'Could not complete the action'), 'a notice opens in English', JSON.stringify(await ask()));
    await js(h.settingsPage, "window.orrery.language('zh'); true");
    check(await until(async () => JSON.stringify(await ask()) === JSON.stringify({ title: '没有完成', buttons: ['确定'] })), 'and follows to Chinese', JSON.stringify(await ask()));
    await js(h.collab, "document.querySelector('dialog.ask[open] button[value=confirm]').click(); true");
    await until(async () => (await ask()) === null);
    // Deleting a task for good: its warning is built from the task, and the whole dialog stays in one language.
    await js(h.collab, "document.getElementById('open-workbench').click(); true");
    const deleteItem = "[...document.querySelectorAll('#wb-more-menu button')].find((b) => /永久删除|Delete permanently/.test(b.textContent))";
    // The cancelled task sits in the folded 已关闭 group: unfold it, open the task, and its 更多 menu has 永久删除.
    const openDeleted = `(() => {
      const fold = [...document.querySelectorAll('dialog.workbench [aria-expanded="false"]')].find((b) => /已关闭/.test(b.textContent));
      fold?.click();
      const card = [...document.querySelectorAll('dialog.workbench .wb-task-title')].find((x) => /Old plan/.test(x.textContent));
      if (card && !document.querySelector('.wb-task-detail')?.textContent.includes('Old plan')) (card.closest('button,[role=button],article,li') ?? card).click();
      return true; })()`;
    check(await until(async () => (await js(h.collab, openDeleted)) === true && (await js(h.collab, `!!${deleteItem}`)) === true, 10_000),
      'the cancelled task is open in the workbench, with 永久删除', await js(h.collab, "document.querySelector('dialog.workbench')?.innerText.replace(/\\s+/g, ' ').slice(0, 500)"));
    await js(h.collab, `${deleteItem}.click(); true`);
    const deleting = async () => { const a = await ask(); return a && { ...a, message: await js(h.collab, "document.querySelector('dialog.ask[open] .ask-message')?.textContent ?? ''") }; };
    const han = /\p{Script=Han}/u;
    const oneLanguage = (a, lang) => !!a && [a.title, a.message, ...a.buttons].every((text) => (lang === 'zh') === han.test(text));
    check(await until(async () => oneLanguage(await deleting(), 'zh')), 'the delete confirmation is open, all Chinese', JSON.stringify(await deleting()));
    await js(h.settingsPage, "window.orrery.language('en'); true");
    check(await until(async () => oneLanguage(await deleting(), 'en') && /Old plan/.test((await deleting()).message)),
      'after a switch to English: title, warning and buttons all English, the task named as before', JSON.stringify(await deleting()));
    await js(h.collab, "(() => { const s = document.getElementById('ui-language'); s.value = 'zh'; s.dispatchEvent(new Event('change')); return true; })()");
    check(await until(async () => oneLanguage(await deleting(), 'zh')), 'and back to all Chinese', JSON.stringify(await deleting()));
    await js(h.collab, "document.querySelector('dialog.ask[open] button[value=cancel]').click(); true");
    check(await until(async () => (await ask()) === null), 'cancelled: nothing deleted');
    const newTask = "[...document.querySelectorAll('dialog.workbench button.primary')].find((b) => /新建任务|New task/.test(b.textContent))";
    check(await until(async () => (await js(h.collab, `!!${newTask}`)) === true), 'the workbench is open');
    await js(h.collab, `${newTask}.click(); true`);
    const form = () => js(h.collab, `(() => { const d = [...document.querySelectorAll('dialog[open]')].find((x) => x.querySelector('form.workbench-form'));
      if (!d) return null; const f = d.querySelector('form'); return { title: f.querySelector('h2').textContent, label: f.querySelector('label').firstChild.textContent,
        typed: f.querySelector('label input').value, priority: [...f.querySelectorAll('select')].map((x) => x.selectedOptions[0]?.textContent).join('|'),
        buttons: [...f.querySelectorAll('.row.end button')].map((b) => b.textContent) }; })()`);
    check(await until(async () => (await form())?.title === '新建任务'), 'the new task form is open', JSON.stringify(await form()));
    await js(h.collab, "(() => { const d = [...document.querySelectorAll('dialog[open]')].find((x) => x.querySelector('form.workbench-form')); d.querySelector('label input').value = 'typed title'; return true; })()");
    await js(h.collab, "(() => { const s = document.getElementById('ui-language'); s.value = 'en'; s.dispatchEvent(new Event('change')); return true; })()");
    check(await until(async () => { const f = await form(); return f?.title === 'New task' && f.label === 'Title' && f.typed === 'typed title'
      && f.priority.includes('Normal') && JSON.stringify(f.buttons) === JSON.stringify(['Cancel', 'Save']); }),
    'the open task form is now English (title, labels, choices, buttons); what was typed stays', JSON.stringify(await form()));
    await js(h.settingsPage, "window.orrery.language('zh'); true");
    check(await until(async () => (await form())?.title === '新建任务' && (await form())?.typed === 'typed title'), 'and back to Chinese', JSON.stringify(await form()));
    await js(h.collab, "(() => { const d = [...document.querySelectorAll('dialog[open]')].find((x) => x.querySelector('form.workbench-form')); d.close(); document.querySelector('dialog.workbench')?.close(); return true; })()");

    console.log('\n[language] the last choice is the language of the next start, whichever entry made it');
    await js(h.collab, "(() => { const s = document.getElementById('ui-language'); s.value = 'en'; s.dispatchEvent(new Event('change')); return true; })()");
    check(await until(async () => (await snapshot(h)).saved === 'en'), 'switched to English from the page');
    for (const w of [h.panel, h.settingsWin, h.win]) if (!w.isDestroyed()) w.destroy();
    h = startShell({ ffi, ensure: async () => ensured, sources, launchTarget });
    check(await ready(h), 'a new shell started (same user data)');
    check(await settingsOpen(), 'its settings view opens');
    s = await snapshot(h);
    check(expectAll(s, 'en') && new URL(h.collab.getURL()).searchParams.get('uiLang') === 'en', 'it opens in English: the page address carries uiLang=en, every page is English',
      JSON.stringify(s));
    await shot(h.collab, '4-page-en-after-restart');
    await js(h.settingsPage, "window.orrery.language('zh'); true");
    check(await until(async () => expectAll(await snapshot(h), 'zh')), 'switched to Chinese from the desktop settings');
    for (const w of [h.panel, h.settingsWin, h.win]) if (!w.isDestroyed()) w.destroy();
    h = startShell({ ffi, ensure: async () => ensured, sources, launchTarget });
    check(await ready(h), 'started once more');
    check(new URL(h.collab.getURL()).searchParams.get('uiLang') === 'zh' && (await js(h.tabs, 'document.documentElement.lang')) === 'zh-CN',
      'it opens in Chinese', h.collab.getURL());
    for (const w of [h.panel, h.settingsWin, h.win]) if (!w.isDestroyed()) w.destroy();
  } catch (e) {
    failed++;
    console.log(`  FAIL ${e instanceof Error ? e.stack : String(e)}`);
  } finally {
    if (hubOrigin) await fetch(`${hubOrigin}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
  }
  console.log(`\n${failed ? `${failed} check(s) failed` : 'all checks passed'}`);
  app.exit(failed ? 1 : 0);
});
