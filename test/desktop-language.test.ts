import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/main.ts';
import { desktopLanguage, desktopPageUrl, isDesktopLanguage, pageLanguage, pageLanguageScript } from '../desktop/ui/language.mjs';
import { setLanguage, t } from '../shared/i18n/index.js';

const shell = readFileSync(join(REPO_ROOT, 'desktop', 'shell.mjs'), 'utf8');

test('desktop language: default and trusted IPC accept only zh or en', () => {
  assert.equal(desktopLanguage(undefined), 'zh');
  assert.equal(desktopLanguage('en'), 'en');
  const validator = /'settings:language': (\(\.\.\.args\) => [^\n]+),/.exec(shell)![1];
  const valid = new Function('isDesktopLanguage', `return ${validator}`)(isDesktopLanguage);
  assert.equal(valid('zh'), true);
  assert.equal(valid('en'), true);
  for (const value of [undefined, null, 'EN', 'fr', 1, {}, ['en']]) assert.equal(valid(value), false);
  assert.equal(valid('en', 'zh'), false);
  assert.match(shell, /JSON\.stringify\(\{ \.\.\.savedState\(state\), language: uiLanguage \}\)/);
  assert.match(shell, /listen\(settingsHandlers, fromSettings\)/);
});

test('desktop language: locale URL preserves token and other query values', () => {
  const page = new URL(desktopPageUrl('http://127.0.0.1:45123/?x=1#token=abc-123', 'en'));
  assert.equal(page.searchParams.get('uiLang'), 'en');
  assert.equal(page.searchParams.get('x'), '1');
  assert.equal(page.hash, '#token=abc-123');
  assert.equal(new URL(desktopPageUrl(page.href, 'zh')).searchParams.get('uiLang'), 'zh');
});

test('desktop language: either side switches every page in place; nothing is loaded again', () => {
  const body = /function switchLanguage\(value, \{ tellPage \}\) \{([\s\S]*?)\n  \}/.exec(shell)![1];
  assert.doesNotMatch(body, /loadURL|reload/);
  for (const step of ['value === uiLanguage) return', 'uiLanguage = value', 'setLanguage(value)', 'persist()', 'if (tellPage) tellPageLanguage()', 'render()']) {
    assert.ok(body.includes(step), step);
  }
  // The desktop settings tell the page; the page's own change is not sent back to it.
  assert.match(shell, /'settings:language': \(value\) => \{ if \(settings && !dialogOpen\) switchLanguage\(value, \{ tellPage: true \}\); \},/);
  const inPage = /wc\.on\('did-navigate-in-page', \(_e, url, isMainFrame\) => \{([\s\S]*?)\n  \}\);/.exec(shell)![1];
  assert.match(inPage, /pageLanguage\(\{ hubOrigin: hubOrigin\(\), url, isMainFrame, current: uiLanguage \}\)/);
  assert.match(inPage, /switchLanguage\(next, \{ tellPage: false \}\)/);
  const tell = /const tellPageLanguage = \(\) => \{([\s\S]*?)\n  \};/.exec(shell)![1];
  assert.match(tell, /allowNavigation\(hub\.origin, wc\.getURL\(\), true\)/, 'only into the Hub page');
  assert.match(tell, /wc\.executeJavaScript\(pageLanguageScript\(uiLanguage\)\)/);
  // The shell's own pages are loaded once, at start, with the saved language.
  assert.equal([...shell.matchAll(/(win|panel|settingsWin)\.loadURL\(/g)].length, 3);
  const html = readFileSync(join(REPO_ROOT, 'desktop', 'ui', 'settings.html'), 'utf8');
  assert.match(html, /桌面和协作页立即一起切换，不会重新加载。/);
});

test('desktop language: only a valid uiLang of the bound Hub page\'s main frame is adopted, and only when it changes', () => {
  const hub = 'http://127.0.0.1:45123';
  const at = (url: string, isMainFrame: unknown = true, current: 'zh' | 'en' = 'zh', hubOrigin: string | null = hub) =>
    pageLanguage({ hubOrigin, url, isMainFrame: isMainFrame as boolean, current });
  assert.equal(at(`${hub}/?uiLang=en#c=1`), 'en');
  assert.equal(at(`${hub}/?x=1&uiLang=zh`, true, 'en'), 'zh');
  assert.equal(at(`${hub}/?uiLang=en`, true, 'en'), null, 'the same value: the round trip of a change the shell sent stops here');
  assert.equal(at(`${hub}/?uiLang=en`, false), null, 'a subframe (a plugin panel) is ignored');
  assert.equal(at(`${hub}/?uiLang=en`, 1), null, 'only isMainFrame === true');
  assert.equal(at(`${hub}/?uiLang=en`, true, 'zh', null), null, 'no Hub bound yet');
  for (const url of ['http://127.0.0.1:45124/?uiLang=en', 'http://localhost:45123/?uiLang=en', 'https://127.0.0.1:45123/?uiLang=en',
    'http://evil.example/?uiLang=en', 'file:///C:/x.html?uiLang=en', 'about:blank', 'not a url', `${hub}/`, `${hub}/?uiLang=EN`,
    `${hub}/?uiLang=fr`, `${hub}/?uiLang=`, `${hub}/#uiLang=en`]) {
    assert.equal(at(url), null, url);
  }
  assert.equal(pageLanguageScript('en'), "window.dispatchEvent(new CustomEvent('orrery:desktop-language', { detail: 'en' })); true");
  for (const bad of ['fr', "en'); alert(1); ('", undefined]) assert.throws(() => pageLanguageScript(bad as any), /zh or en/);
});

test('desktop language: shell and page converge from either side without looping', () => {
  // The shell's rule (pageLanguage, tellPage) and the page's rule (setLanguage fires only on a change, then rewrites its
  // address) played against each other; each side reacts only to a different value, so every exchange ends.
  const hub = 'http://127.0.0.1:45123';
  const shellSide = { lang: 'zh' as 'zh' | 'en', saved: 'zh', told: 0 };
  const page = { url: `${hub}/?uiLang=zh#c=1` };
  const navigations: string[] = [];
  const pageSet = (value: 'zh' | 'en') => {   // setLanguage on the page: no event and no rewrite for the same value
    if (new URL(page.url).searchParams.get('uiLang') === value) return;
    const u = new URL(page.url); u.searchParams.set('uiLang', value); page.url = u.href;
    navigations.push(page.url);
    onInPage(page.url);
  };
  const switchShell = (value: 'zh' | 'en', tellPage: boolean) => {
    if (value === shellSide.lang) return;
    shellSide.lang = value; shellSide.saved = value;
    if (tellPage) { shellSide.told++; pageSet(value); }
  };
  function onInPage(url: string) {
    const next = pageLanguage({ hubOrigin: hub, url, isMainFrame: true, current: shellSide.lang });
    if (next) switchShell(next, false);
  }
  for (let round = 0; round < 4; round++) {
    pageSet('en');                 // 协作页设置 → English
    assert.deepEqual([shellSide.lang, shellSide.saved, new URL(page.url).searchParams.get('uiLang')], ['en', 'en', 'en']);
    switchShell('zh', true);       // 桌面设置 → 中文
    assert.deepEqual([shellSide.lang, shellSide.saved, new URL(page.url).searchParams.get('uiLang')], ['zh', 'zh', 'zh']);
  }
  assert.equal(navigations.length, 8, 'one address rewrite per change, none echoed back');
  assert.equal(shellSide.told, 4);
  assert.equal(new URL(page.url).hash, '#c=1');
});

test('desktop language: the next manual refresh applies the current preference and preserves the fragment', () => {
  const body = /const reloadCollab = \(\) => \{([\s\S]*?)\n  \};/.exec(shell)![1];
  const loads: string[] = [];
  const page = 'http://127.0.0.1:45123/?uiLang=zh#cluster=draft-owner';
  const wc = { isDestroyed: () => false, getURL: () => page, loadURL: (url: string) => { loads.push(url); return Promise.resolve(); } };
  const reload = new Function('wc', 'hub', 'hubPage', 'uiLanguage', 'allowNavigation', 'desktopPageUrl', body)(
    wc, { status: 'ready', origin: 'http://127.0.0.1:45123' }, page, 'en', () => true, desktopPageUrl);
  assert.equal(reload, undefined);
  assert.equal(new URL(loads[0]).searchParams.get('uiLang'), 'en');
  assert.equal(new URL(loads[0]).hash, '#cluster=draft-owner');
});

test('desktop language: main-frame identity rejects foreign pages; the page\'s own uiLang may be either language', () => {
  const body = /const fromPage = \(event, wc, url\) => \{([\s\S]*?)\n  \};/.exec(shell)![1];
  const fromPage = new Function('desktopPageUrl', `return (event, wc, url) => {${body}}`)(desktopPageUrl);
  const url = 'file:///orrery/desktop/ui/settings.html';
  const mainFrame = { processId: 12, routingId: 34 };
  const wc = { isDestroyed: () => false, mainFrame };
  const frame = { ...mainFrame, parent: null, url: desktopPageUrl(url, 'en') };
  assert.equal(fromPage({ sender: wc, senderFrame: frame }, wc, url), true);
  assert.equal(fromPage({ sender: wc, senderFrame: { ...frame, url: desktopPageUrl(url, 'zh') } }, wc, url), true,
    'a call sent just before the page switched its own address is still that page');
  for (const senderFrame of [{ ...frame, parent: {} }, { ...frame, routingId: 99 }, { ...frame, url }, { ...frame, url: `${url}?uiLang=fr` },
    { ...frame, url: 'file:///orrery/desktop/ui/strip.html?uiLang=en' }, { ...frame, url: 'http://127.0.0.1:45123/?uiLang=en' }]) {
    assert.equal(fromPage({ sender: wc, senderFrame }, wc, url), false, senderFrame.url);
  }
  assert.equal(fromPage({ sender: {}, senderFrame: frame }, wc, url), false);
});

test('desktop language: English is explicit and user names, titles and paths remain untouched', (ctx) => {
  setLanguage('en');
  ctx.after(() => setLanguage('zh'));
  assert.equal(t('界面语言'), 'Interface language');
  assert.equal(t('确定'), 'OK');
  assert.equal(t('打开'), 'Open');
  assert.equal(t('{name} 现在没有在运行的窗口', { name: '用户自己的标题' }), '用户自己的标题 has no running windows');
  assert.equal(t('{label}：{path}', { label: 'Saved', path: 'C:\\用户目录\\程序.exe' }), 'Saved: C:\\用户目录\\程序.exe');
  assert.match(t('启动器给出的地址不能用：{url}', { url: 'not-a-url' }), /invalid URL: not-a-url$/);
});
