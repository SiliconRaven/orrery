// The page never scrolls as a whole (style.css #app is the window's height; every list scrolls on its own). A .sr-only
// text is absolutely positioned; inside a scrolling list with no positioned ancestor (the member cards' "模型 / 项目 /
// 对话" words) its containing block is the page itself, so left at its static position it escaped the list's clip and,
// at its place in the unscrolled list, made the document taller than the window: an outer scroll bar, and a wheel at
// the end of the member list scrolled the whole app up over blank space (seen in the desktop shell). Pinning the box
// to its containing block's corner keeps it inside the window whatever list it sits in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/main.ts';

const PUB = join(REPO_ROOT, 'src', 'web', 'public');

test('sr-only: absolutely positioned and pinned with top and left, never at its static position', () => {
  const css = readFileSync(join(PUB, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/(^|\})\s*\.sr-only\s*\{([^}]*)\}/g)].map((m) => m[2]);
  assert.equal(rules.length, 1, 'one .sr-only rule');
  const decl = Object.fromEntries(rules[0].split(';').map((d) => d.split(':').map((s) => s.trim())).filter(([k]) => k));
  assert.equal(decl.position, 'absolute');
  assert.ok(decl.inset !== undefined || (decl.top !== undefined && decl.left !== undefined),
    'a top and a left offset (or inset): without them the box sits where it would be in the flow');
  for (const file of ['workbench.css', 'settings.css', 'chat-search.css']) {
    assert.doesNotMatch(readFileSync(join(PUB, file), 'utf8'), /\.sr-only\b/, `${file} does not override .sr-only`);
  }
});
