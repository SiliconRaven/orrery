// Every empty list or panel of the page is ui.js emptyState (docs/architecture.md「网页的图标、空状态和在线圈」): the orbit
// picture, one sentence, an optional action; compact inside a card. The page's scripts may not build their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

const PUB = join(REPO_ROOT, 'src', 'web', 'public');
const ui = await import(pathToFileURL(join(PUB, 'ui.js')).href);

type El = { tag: string; ns: boolean; attrs: Record<string, string>; kids: (El | string)[]; on: Record<string, unknown>; hidden?: boolean;
  setAttribute(k: string, v: string): void; addEventListener(k: string, f: unknown): void; append(...c: (El | string)[]): void };
const make = (tag: string, ns = false): El => ({ tag, ns, attrs: {}, kids: [], on: {},
  setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.on[k] = f; }, append(...c) { this.kids.push(...c); } });
const text = (e: El | string): string => (typeof e === 'string' ? e : e.kids.map(text).join(''));

test('empty state: the orbit picture (decorative), one sentence and an optional action; compact for rows in a card', (t) => {
  const prev = (globalThis as any).document;
  (globalThis as any).document = { createElement: (tag: string) => make(tag), createElementNS: (_: string, tag: string) => make(tag, true) };
  t.after(() => { (globalThis as any).document = prev; });

  const plain = ui.emptyState('还没有任务。') as El;
  assert.deepEqual([plain.tag, plain.attrs.class], ['div', 'empty-state']);
  const [art, p, ...rest] = plain.kids as El[];
  assert.deepEqual([art.tag, art.ns, art.attrs.class, art.attrs['aria-hidden'], art.attrs.viewBox], ['svg', true, 'empty-art', 'true', '0 0 24 24']);
  assert.equal(art.kids.length, 1);
  assert.deepEqual([(art.kids[0] as El).tag, (art.kids[0] as El).attrs.href], ['use', '#i-orbit'], 'the same currentColor brand symbol');
  assert.deepEqual([p.tag, text(p)], ['p', '还没有任务。']);
  assert.deepEqual(rest, [], 'no action unless asked');
  assert.equal(text(plain), '还没有任务。', 'the picture adds no text');

  let clicked = 0;
  const withAction = ui.emptyState('回收站为空。', { action: { label: '新建', onclick: () => clicked++ } }) as El;
  const button = withAction.kids[2] as El;
  assert.deepEqual([button.tag, button.attrs.type, button.attrs.class, text(button)], ['button', 'button', 'small', '新建']);
  (button.on.click as () => void)();
  assert.equal(clicked, 1);
  const node = Object.assign(make('button'), { nodeType: 1 });   // a DOM node
  assert.equal((ui.emptyState('x', { action: node }) as El).kids[2], node, 'a node is used as it is');

  const compact = ui.emptyState(['当前群没有成员。'], { compact: true }) as El;
  assert.equal(compact.attrs.class, 'empty-state compact');
  assert.equal((compact.kids[0] as El).attrs.class, 'empty-art', 'compact keeps a small picture (20 px in CSS)');
});

test('empty state: no page script builds its own empty markup; the roles page uses the compact one', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : name.endsWith('.js') ? [p] : [];
  });
  const OLD = /class: '(?:[^']* )?(empty|welcome|wb-rp-empty|plugin-empty|search-empty|workbench-graph-empty|group-empty)(?: [^']*)?'/;
  // A bare line of muted text saying there is nothing: what the empty state replaced.
  const AD_HOC = /h\('(?:p|span|li|div)', \{ class: '[^']*'[^}]*\}, '(?:暂无|还没有|没有|空)/;   // other props (hidden: true …) too
  const bad: string[] = [];
  for (const p of files(PUB)) {
    const file = relative(PUB, p).replace(/\\/g, '/');
    readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      if (OLD.test(line) || AD_HOC.test(line)) bad.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
      if (file !== 'ui.js' && /'empty-state|'empty-art/.test(line)) bad.push(`${file}:${i + 1}: builds the empty state's markup itself`);
    });
  }
  assert.deepEqual(bad, [], 'use emptyState(text, { action, compact }) from ui.js');

  const wb = readFileSync(join(PUB, 'workbench.js'), 'utf8');
  assert.match(wb, /const rpEmpty = \(text\) => emptyState\(text, \{ compact: true \}\);/);
  for (const sentence of ['还没有长期要求。', '当前群没有成员。', '标签库里还没有组。']) assert.match(wb, new RegExp(`rpEmpty\\(t\\(["']${sentence}`));
  // The places the task names: each goes through the helper.
  const uses = (file: string, re: RegExp) => assert.match(readFileSync(join(PUB, file), 'utf8'), re, file);
  uses('app.js', /emptyState\(placeholder, \{ action: filtered/);                  // a chat with no (shown) messages
  uses('app.js', /list\.replaceChildren\(emptyState\(t\('还没有集群。'/);               // no clusters
  uses('app.js', /emptyState\(t\('集群暂无成员，可以添加成员继续协作。'\)\)/);             // no members
  uses('workbench.js', /emptyState\(narrowed\(\) \? t\("没有符合筛选条件的任务。"\) : t\("还没有任务/);   // no tasks
  uses('trash.js', /emptyState\(t\("回收站为空。"\)\)/);                                   // empty trash
  assert.match(readFileSync(join(REPO_ROOT, 'src/plugins/bookmarks/package/web/index.js'), 'utf8'), /emptyState\(t\("没有符合条件的收藏。"\)\)/, 'bookmarks');      // empty library
  uses('plugins.js', /cards\.length \? cards : emptyState\(empty/);                   // no plugins
  uses('chat-search.js', /const empty = emptyState\(''\);/);                          // search without results
});
