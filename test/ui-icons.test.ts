// Icons in the page's controls come from index.html's sprite, never from text glyphs or emoji (docs/architecture.md「网页的
// 图标、空状态和在线圈」). Every script, page and stylesheet under src/web/public is scanned with its comments removed; a
// symbol or emoji left in code fails here unless ALLOW below says where it is and why it is prose or user text, not an icon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT } from '../src/main.ts';

const PUB = join(REPO_ROOT, 'src', 'web', 'public');
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? files(p) : /\.(js|html|css)$/.test(name) ? [p] : [];
});
const SOURCES = files(PUB).map((p) => ({ file: relative(PUB, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));

test('brand: the sprite keeps the original single-orbit mark and themed filled stars', () => {
  const html = SOURCES.find((s) => s.file === 'index.html')!.text;
  const source = readFileSync(join(REPO_ROOT, 'desktop', 'assets', 'orrery-mark.svg'), 'utf8');
  const symbol = /<symbol id="i-orbit"[^>]*>([\s\S]*?)<\/symbol>/.exec(html)![1];
  assert.ok(symbol.includes(`d="${/<path d="([^"]+)"/.exec(source)![1]}"`));
  assert.match(symbol, /stroke-linecap="round"/);
  const stars = [...source.matchAll(/<circle (cx="[^"]+" cy="[^"]+" r="[^"]+")/g)];
  assert.equal(stars.length, 2);
  for (const star of stars) assert.ok(symbol.includes(`${star[1]} fill="currentColor" stroke="none"`));
  assert.doesNotMatch(symbol, /ellipse|#[0-9a-f]{3,8}/i);
  assert.match(html, /class="brand-mark"[^>]*><use href="#i-orbit"/);
  assert.match(html, /name="theme" value="orrery"><svg[^>]*><use href="#i-orbit"/);
});

/** The text without comments; a comment's line breaks stay, so line numbers still match the file. */
function code(file: string, text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  if (file.endsWith('.html')) return text.replace(/<!--[\s\S]*?-->/g, blank);
  // Only comments that start a line or follow a space: '//' in a URL and '/*' in 'image/*' are code.
  return text.replace(/(^|\s)\/\*[\s\S]*?\*\//g, blank).replace(/(^|[\s;])\/\/.*$/gm, blank);
}

// Symbols (So, Sm), pictographs (emoji), arrows, box/geometric shapes, dingbats, and the fullwidth signs used as icons.
const GLYPH = /[\p{So}\p{Sm}\p{Extended_Pictographic}←-⇿⌀-⏿─-➿⬀-⯿‹›＊＋－～]/u;

// Kept on purpose: each entry is a file, the glyph, a pattern of its line, and why it is not an icon.
const ALLOW: { file: string; glyph: string; line: RegExp; why: string }[] = [
  { file: 'app.js', glyph: '→', line: /\bt\('工作目录 \{fromCwd\} → \{toCwd\}', \{ fromCwd: r\.fromCwd, toCwd: r\.toCwd \}\)/, why: 'the rebind preview: an arrow inside a sentence, old → new' },
  { file: 'task-diff-view.js', glyph: '→', line: /change\?\.before, resolve\)\} → \$\{scalar/, why: 'a field change: old → new inside a sentence' },
  { file: 'workbench.js', glyph: '→', line: /\bt\(" · 验收方式 \{before\} → \{after\} · 依据 \{basis\}", \{ before: reviewModeText\(item\.reviewFrom\b/, why: 'a takeover record: old → new inside a sentence' },
  { file: 'workbench.js', glyph: '→', line: /TASK_SORTS = |'优先级 高→低'/, why: 'sort orders (新→旧) are <option> text, which cannot hold an icon; the arrow reads as words' },
  { file: 'app.js', glyph: '🦊', line: /\bplaceholder: l?t\('例如 🦊'\)/, why: 'an example of an emoji avatar the user may type: user text, not an icon' },
  { file: 'index.html', glyph: '🦊', line: /placeholder="例如 🦊"/, why: 'the same example in the member editor' },
  { file: 'app.js', glyph: '≤', line: /≤256 KB/, why: 'a size limit written as maths in a sentence' },
  { file: 'index.html', glyph: '≤', line: /≤256 KB/, why: 'the same limit in the member editor' },
  { file: 'index.html', glyph: '←', line: /aria-label="调整.*（←\/→，双击恢复默认）"/, why: 'names the arrow keys that move a divider' },
  { file: 'index.html', glyph: '→', line: /aria-label="调整.*（←\/→，双击恢复默认）"/, why: 'names the arrow keys that move a divider' },
  { file: 'workbench-labels.js', glyph: '～', line: /（1～20 字）/, why: 'a length range in a field label' },
  { file: 'workbench.js', glyph: '～', line: /7～40 位十六进制/, why: 'a length range in a placeholder' },
];

test('icons: no symbol or emoji stands in for an icon in the page\'s code (sprite icons only)', () => {
  const found: string[] = [];
  const used = new Set<number>();
  for (const { file, text } of SOURCES) {
    code(file, text).split('\n').forEach((line, i) => {
      for (const ch of new Set([...line].filter((c) => c.codePointAt(0)! > 127 && GLYPH.test(c)))) {
        const k = ALLOW.findIndex((a) => a.file === file && a.glyph === ch && a.line.test(line));
        if (k >= 0) used.add(k);
        else found.push(`${file}:${i + 1}: ${ch}  ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(found, [], 'use icon(name) from ui.js (or <svg class="ico"><use href="#i-name"/></svg> in index.html) instead');
  assert.deepEqual(ALLOW.filter((_, k) => !used.has(k)).map((a) => `${a.file} ${a.glyph}`), [], 'an allow-list entry that matches nothing any more: remove it');
});

test('icons: every icon the scripts and the page ask for is a symbol of the sprite', () => {
  const html = readFileSync(join(PUB, 'index.html'), 'utf8');
  const symbols = new Set([...html.matchAll(/<symbol id="i-([\w-]+)"/g)].map((m) => m[1]));
  const wanted = new Set<string>();
  for (const { file, text } of SOURCES) {
    for (const m of text.matchAll(/\bicon\(\s*'([\w-]+)'/g)) wanted.add(m[1]);
    for (const m of text.matchAll(/\bicon: '([\w-]+)'/g)) wanted.add(m[1]);   // ui.js DELIVERY_STATE and memberRowActions
    for (const m of text.matchAll(/href="#i-([\w-]+)"/g)) wanted.add(m[1]);
  }
  assert.ok(wanted.size > 20, `the scan finds the icons in use (${wanted.size})`);
  assert.deepEqual([...wanted].filter((name) => !symbols.has(name)).sort(), []);
  // Each symbol is drawn on the 24 px grid; strokes come from .ico (currentColor), so none sets its own colour.
  for (const m of html.matchAll(/<symbol id="i-([\w-]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)) {
    assert.equal(m[2], '0 0 24 24', m[1]);
    assert.doesNotMatch(m[3], /\b(stroke|fill)="(?!currentColor"|none")/, `${m[1]}: colours come from currentColor`);
  }
});
