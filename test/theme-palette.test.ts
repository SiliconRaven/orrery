// The 星仪 palette (style.css :root[data-theme="orrery"]) overrides every colour token :root defines, and its text pairs
// meet WCAG AA (4.5:1). Light and dark are measured too, but only reported (t.diagnostic), not enforced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/main.ts';

const style = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'style.css'), 'utf8');

/** The `--name: value` declarations of the first rule whose selector is exactly `selector`. */
function tokens(selector: string): Map<string, string> {
  const start = style.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} rule exists`);
  const body = style.slice(style.indexOf('{', start) + 1, style.indexOf('}', start));
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const isColour = (value: string) => /#[0-9a-f]{3,8}\b|light-dark\(|rgba?\(|hsla?\(/i.test(value);
// Colour tokens on :root that 星仪 deliberately leaves to the dark value. None today; name one here with its reason.
const INHERITS_DARK: string[] = [];

const root = tokens(':root');
const orrery = tokens(':root[data-theme="orrery"]');

test('星仪 overrides exactly the colour tokens :root defines, no parallel set', () => {
  const colours = [...root].filter(([, v]) => isColour(v)).map(([k]) => k).filter((k) => !INHERITS_DARK.includes(k));
  assert.ok(colours.length >= 10, 'found the colour tokens');
  assert.deepEqual([...orrery.keys()].sort(), colours.sort());
  for (const [k, v] of orrery) assert.match(v, /^#[0-9a-f]{6}$/i, `${k} is a plain hex colour`);
});

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const PAIRS = [['--text', '--bg'], ['--text', '--surface'], ['--text', '--surface-2'], ['--muted', '--bg'], ['--muted', '--surface'], ['--muted', '--surface-2'],
  ['--on-accent', '--accent'], ['--warn-text', '--warn-bg']] as const;
/** A theme's value of a token: 星仪's own, or one side of :root's light-dark(light, dark). */
function palette(theme: 'light' | 'dark' | 'orrery') {
  return (name: string) => {
    if (theme === 'orrery') return orrery.get(name)!;
    const m = /^light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)$/i.exec(root.get(name) ?? '');
    assert.ok(m, `${name} is light-dark(#hex, #hex)`);
    return theme === 'light' ? m[1] : m[2];
  };
}

test('星仪 text pairs reach 4.5:1', (t) => {
  const value = palette('orrery');
  for (const [fg, bg] of PAIRS) {
    const ratio = contrast(value(fg), value(bg));
    t.diagnostic(`orrery ${fg} on ${bg}: ${ratio.toFixed(2)}`);
    assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
  }
});

test('light and dark text pairs (reported, not enforced)', (t) => {
  for (const theme of ['light', 'dark'] as const) {
    const value = palette(theme);
    for (const [fg, bg] of PAIRS) {
      const ratio = contrast(value(fg), value(bg));
      t.diagnostic(`${theme} ${fg} on ${bg}: ${ratio.toFixed(2)}${ratio < 4.5 ? '  BELOW 4.5' : ''}`);
    }
  }
});
