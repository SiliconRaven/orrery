import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/main.ts';
import { desktopLanguage, desktopPageUrl, isDesktopLanguage } from '../desktop/ui/language.mjs';
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

test('desktop language: changing the preference leaves the collaboration page and its drafts intact', () => {
  const handler = /'settings:language': \(value\) => \{([\s\S]*?)\n    \},/.exec(shell)![1];
  assert.doesNotMatch(handler, /\bwc\.(?:loadURL|reload)\(/);
  for (const view of ['win', 'panel', 'settingsWin']) assert.match(handler, new RegExp(`${view}\\.loadURL\\(desktopPageUrl\\(`));
  const html = readFileSync(join(REPO_ROOT, 'desktop', 'ui', 'settings.html'), 'utf8');
  assert.match(html, /协作页下次打开或刷新时生效/);
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

test('desktop language: main-frame identity still rejects foreign pages and stale locale frames', () => {
  const body = /const fromPage = \(event, wc, url\) => \{([\s\S]*?)\n  \};/.exec(shell)![1];
  const fromPage = new Function('desktopPageUrl', 'uiLanguage', `return (event, wc, url) => {${body}}`)(desktopPageUrl, 'en');
  const url = 'file:///orrery/desktop/ui/settings.html';
  const mainFrame = { processId: 12, routingId: 34 };
  const wc = { isDestroyed: () => false, mainFrame };
  const frame = { ...mainFrame, parent: null, url: desktopPageUrl(url, 'en') };
  assert.equal(fromPage({ sender: wc, senderFrame: frame }, wc, url), true);
  for (const senderFrame of [{ ...frame, parent: {} }, { ...frame, routingId: 99 }, { ...frame, url },
    { ...frame, url: desktopPageUrl(url, 'zh') }, { ...frame, url: 'http://127.0.0.1:45123/?uiLang=en' }]) {
    assert.equal(fromPage({ sender: wc, senderFrame }, wc, url), false);
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
