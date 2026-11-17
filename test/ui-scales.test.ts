// The page's size scales (style.css: spacing, type, radius, shadow) and its shared component bases. Every stylesheet the
// page loads is parsed; a radius, font size or shadow that is not a scale token fails here, unless it is in ALLOW below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/main.ts';

const PUB = join(REPO_ROOT, 'src', 'web', 'public');
const html = readFileSync(join(PUB, 'index.html'), 'utf8');
const SHEETS = [...html.matchAll(/<link rel="stylesheet" href="\/([\w-]+\.css)">/g)].map((m) => m[1]);

type Decl = { file: string; selector: string; prop: string; value: string };
/** Every declaration with the selector of its rule (at-rule wrappers dropped), comments removed. */
function declarations(file: string): Decl[] {
  const src = readFileSync(join(PUB, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Decl[] = [];
  const stack: string[] = [];
  let buf = '';
  const emit = () => {
    const m = /^\s*([-\w]+)\s*:\s*([\s\S]+?)\s*$/.exec(buf);
    if (m && stack.length) out.push({ file, selector: stack[stack.length - 1], prop: m[1], value: m[2].replace(/\s+/g, ' ') });
    buf = '';
  };
  for (const c of src) {
    if (c === '{') { stack.push(buf.trim().replace(/\s+/g, ' ')); buf = ''; } else if (c === '}') { if (buf.trim()) emit(); stack.pop(); buf = ''; } else if (c === ';') emit(); else buf += c;
  }
  return out;
}
const ALL = SHEETS.flatMap(declarations);

// Exceptions, by pattern. Keep this short; each says why it is not on a scale.
const ALLOW: { prop: string; value: RegExp; why: string }[] = [
  { prop: 'font-size', value: /^[\d.]+em$/, why: 'relative to the text around it: markdown headings, inline code and task numbers follow their message or title' },
  { prop: 'font-size', value: /^calc\(var\(--(size|m)\) \* [\d.]+\)$/, why: 'an avatar\'s letter or emoji scales with the avatar' },
  { prop: 'box-shadow', value: /^(?:(?:inset )?0 0 0 (?:[\d.]+px|max\(2px, calc\(var\(--size\) \* [\d.]+\)\)) (?:var\(--[\w-]+\)|currentColor|color-mix\(.*\)|light-dark\(.*\))(?:, |$))+$/,
    why: 'a ring (spread only): a border that takes no room, not an elevation' },
  { prop: 'box-shadow', value: /^0 0 12px -2px color-mix\(in srgb, var\(--accent\) 55%, transparent\)$/, why: '星仪\'s glow on primary buttons, a colour accent of that theme, not an elevation' },
];
const TOKEN = { 'border-radius': /^var\(--r-(xs|sm|md|lg|xl|pill)\)$/, 'font-size': /^var\(--f-(xs|sm|md|base|lg)\)$/, 'box-shadow': /^var\(--(shadow-(raised|popover|dialog)|edge-current|edge-tab|halo)\)$/ };
const KEYWORDS = new Set(['0', 'none', 'inherit', '50%']);

function onScale(prop: keyof typeof TOKEN, value: string): boolean {
  if (KEYWORDS.has(value)) return true;
  if (ALLOW.some((a) => a.prop === prop && a.value.test(value))) return true;
  // A shorthand of several corners, or several shadows: each part on the scale (shadows may mix tokens and rings).
  const parts = prop === 'box-shadow' ? value.split(/,\s*(?![^()]*\))/) : value.split(' ');
  return parts.length > 1 && parts.every((p) => TOKEN[prop].test(p) || KEYWORDS.has(p) || ALLOW.some((a) => a.prop === prop && a.value.test(p)));
}

test('scales: the page loads the stylesheets this test reads', () => {
  assert.deepEqual(SHEETS, ['style.css', 'workbench.css', 'settings.css', 'chat-search.css']);
});

test('scales: :root defines each step once, and --radius stays as the old name of --r-lg', () => {
  const root = ALL.filter((d) => d.file === 'style.css' && d.selector === ':root');
  const defined = new Map(root.filter((d) => d.prop.startsWith('--')).map((d) => [d.prop, d.value]));
  for (const [k, v] of Object.entries({ '--s-1': '4px', '--s-2': '8px', '--s-3': '12px', '--s-4': '16px', '--s-5': '24px', '--s-6': '32px',
    '--f-xs': '11px', '--f-sm': '12px', '--f-md': '13px', '--f-base': '14px', '--f-lg': '16px',
    '--r-xs': '4px', '--r-sm': '6px', '--r-md': '8px', '--r-lg': '10px', '--r-xl': '14px', '--r-pill': '999px', '--radius': 'var(--r-lg)' })) {
    assert.equal(defined.get(k), v, k);
  }
  for (const k of ['--shadow-raised', '--shadow-popover', '--shadow-dialog', '--edge-current', '--edge-tab', '--halo']) assert.ok(defined.has(k), k);
  // Tokens only: no theme block redefines a size; 星仪 may only recolour.
  const themed = ALL.filter((d) => /data-theme/.test(d.selector) && /^--(s|f|r|shadow|edge)-|^--radius$|^--halo$/.test(d.prop));
  assert.deepEqual(themed, []);
});

for (const prop of Object.keys(TOKEN) as (keyof typeof TOKEN)[]) {
  test(`scales: every ${prop} in the page's stylesheets is a scale token or an allowed exception`, () => {
    const off = ALL.filter((d) => d.prop === prop && !TOKEN[prop].test(d.value) && !onScale(prop, d.value));
    assert.deepEqual(off.map((d) => `${d.file} ${d.selector} { ${d.prop}: ${d.value} }`), []);
  });
}

// ---- component families: one base rule each ----
const items = (selector: string) => selector.split(/,(?![^()]*\))/).map((s) => s.trim());
/** The classes of a selector item's last compound (what the rule styles), pseudo-elements excluded. */
const targetClasses = (item: string) => item.includes('::') ? [] : [...(item.split(/\s+|\s*[>+~]\s*/).pop() ?? '').matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
/** The one rule with this exact selector list (whitespace-normalised). */
function rule(file: string, startsWith: string) {
  const all = [...new Set(ALL.filter((d) => d.file === file && d.selector.startsWith(startsWith)).map((d) => d.selector))];
  const found = all.includes(startsWith) ? [startsWith] : all;   // an exact selector wins over longer ones it begins
  assert.equal(found.length, 1, `one rule starting ${startsWith} in ${file}: ${found.join(' | ')}`);
  return found[0];
}
/** Declarations of `props` in rules that style any of `classes`, outside the `allowed` selectors. */
function strays(classes: Set<string>, props: RegExp, allowed: string[]) {
  return ALL.filter((d) => props.test(d.prop) && !allowed.includes(d.selector) && items(d.selector).some((i) => targetClasses(i).some((c) => classes.has(c))))
    .map((d) => `${d.file} ${d.selector} { ${d.prop}: ${d.value} }`);
}

test('chips: one base rule sets the shape (padding, radius, font size, line height) of every chip, badge, count and mark', () => {
  assert.ok(ALL.length > 2000, 'parsed the stylesheets');
  const base = rule('style.css', '.unread-badge, .stalled-badge');
  const shape = new Map(ALL.filter((d) => d.selector === base).map((d) => [d.prop, d.value]));
  assert.equal(shape.get('border-radius'), 'var(--r-pill)');
  assert.equal(shape.get('font-size'), 'var(--f-sm)');
  assert.equal(shape.get('line-height'), '18px');
  const classes = new Set(items(base).flatMap(targetClasses));
  for (const c of ['wb-status', 'wb-role', 'wb-tag', 'plugin-chip', 'hidden-mark', 'search-mark', 'unread-badge', 'wb-rp-perm', 'restart-badge']) assert.ok(classes.has(c), c);
  // The two modifiers: counts, and the larger clickable chips (also in the narrow layout's media rule).
  const counts = rule('style.css', '.unread-badge, .menu-count, .wb-fb-badge, .wb-fb-qcount');
  const large = '.wb-filter-chip, .wb-lp-chip';
  assert.deepEqual(strays(new Set([...classes, 'wb-lp-chip']), /^(padding.*|border-radius|font-size|line-height|height|min-height)$/, [base, counts, large]), []);
});

test('switch: the sidebar toggle and .plugin-switch are one design (track, knob and the on state are shared rules)', () => {
  const track = rule('style.css', '.switch, .plugin-switch input');
  const knob = rule('style.css', '.switch::after, .plugin-switch input::before');
  const on = rule('style.css', '.toggle:not([aria-pressed="true"]) .switch, .plugin-switch input:checked');
  const shape = /^(width|height|border-radius|background|top|left|box-shadow)$/;
  const others = ALL.filter((d) => shape.test(d.prop) && ![track, knob, on].includes(d.selector) && !d.selector.startsWith('.toggle:not([aria-pressed="true"]) .switch::after')
    && items(d.selector).some((i) => /(^|\s)\.switch\b|\.plugin-switch input/.test(i)))
    .map((d) => `${d.file} ${d.selector} { ${d.prop} }`);
  assert.deepEqual(others, []);
});

test('switch: every real role=switch in the page scripts and markup sits in the shared .plugin-switch host', () => {
  const sources = readdirSync(PUB, { recursive: true }).map(String).filter((f) => /\.(js|html)$/.test(f))
    .map((f) => [f.replaceAll('\\', '/'), readFileSync(join(PUB, f), 'utf8')] as const);
  const sites = sources.flatMap(([f, src]) => [...src.matchAll(/role(?:: '|=")switch/g)].map(() => f));
  // Each caller, and how its input reaches a .plugin-switch label. A new switch must be added here with its host.
  const hosts: [string, RegExp][] = [
    ['plugins.js', /h\('label', \{ class: 'plugin-switch' \},\s*h\('input', \{\s*type: 'checkbox', role: 'switch', 'aria-label': `启用/],
    ['plugins.js', /const wake = [^;]*role: 'switch'[\s\S]*h\('label', \{ class: 'plugin-switch[ '][^}]*\}, wake, /],
    ['workbench.js', /const settingSwitch = \(props\) => h\('label', \{ class: 'plugin-switch' \}, h\('input', \{ type: 'checkbox', role: 'switch'/],
  ];
  assert.deepEqual(sites.sort(), hosts.map(([f]) => f).sort(), 'every role=switch is one of the known callers');
  for (const [f, re] of hosts) assert.match(sources.find(([g]) => g === f)![1], re, `${f}: the switch is inside a .plugin-switch label`);
});

test('chosen state: current rows, current page tabs and segmented controls each have one look, set in one rule', () => {
  const rows = rule('style.css', '.cluster-item.active, .conversation-nav.active');
  const tabs = rule('style.css', '.workbench-tabs button[aria-current="true"]');
  const thumb = rule('style.css', '.segmented label:has(input:checked), .view-switch button[aria-pressed="true"]');
  const look = (sel: string) => new Map(ALL.filter((d) => d.selector === sel).map((d) => [d.prop, d.value]));
  assert.equal(look(rows).get('box-shadow'), 'var(--edge-current)');
  assert.equal(look(rows).get('background'), 'var(--accent-soft)');
  assert.equal(look(tabs).get('box-shadow'), 'var(--edge-tab)');
  // Every other rule on a chosen item may change only its weight or icon colour; the rails turn into tabs when narrow.
  const chosen = items(rows).concat(items(tabs), items(thumb));
  const others = ALL.filter((d) => /^(background|background-color|box-shadow|border-color)$/.test(d.prop) && ![rows, tabs, thumb].includes(d.selector)
    && items(d.selector).some((i) => chosen.includes(i)));
  assert.deepEqual(others.map((d) => `${d.file} ${d.selector} { ${d.prop}: ${d.value} }`),
    ['workbench.css .wb-rp-rail button[aria-current="true"] { box-shadow: var(--edge-tab) }',
      'settings.css .settings-nav [role="tab"][aria-selected="true"] { box-shadow: var(--edge-tab) }']);
});

test('buttons: default, small, danger and icon-only are each defined once (no local copies)', () => {
  const where = (re: RegExp, props: RegExp) => ALL.filter((d) => props.test(d.prop) && items(d.selector).some((i) => re.test(i))).map((d) => `${d.file} ${d.selector} { ${d.prop} }`);
  const base = rule('style.css', 'button, label.button, a.button');
  const small = rule('style.css', 'button.small, .button.small');
  assert.deepEqual(where(/(^|\s)a\.button\b/, /^(border.*|padding.*|font-size|background|text-decoration)$/).filter((s) => !s.includes(base) && !s.includes('a.button:hover') && !s.includes('label.button, a.button {')), []);
  assert.deepEqual(where(/\.small\b/, /^(padding.*|font-size|line-height|min-height)$/).filter((s) => !s.startsWith(`style.css ${small} `)),
    ['workbench.css .wb-rp button.small { min-height }'], 'only the touch-size bump of the narrow roles page');
  // Danger: red text and a tinted edge from one rule; the filled one for confirming; a red ghost icon in the member list.
  assert.deepEqual(where(/\.danger\b/, /^(color|border-color|border)$/), [
    'style.css button.danger { border-color }', 'style.css button.danger { color }', 'style.css button.primary.danger { border-color }',
    'style.css button.primary.danger { color }', 'style.css button.icon-button.ghost.member-action.danger { color }']);
  const icon = rule('style.css', 'button.icon, button.icon-button');
  // Icon-only buttons are 32 px squares; only these change their size: touch targets, and the few tight spots.
  const resized = where(/button\.icon\b|\.icon-button\b/, /^(width|height)$/).filter((s) => !s.startsWith(`style.css ${icon} `) && !s.includes('::'));
  assert.deepEqual([...new Set(resized.map((s) => s.replace(/^style\.css (.*) \{ \w+ \}$/, '$1')))].sort(),
    ['.chat-head .icon-button', '.composer .icon-button', '.pending-file button.icon', '.side-head .icon-button', 'button.icon-button.member-action']);
});

test('dialogs: one frame, one backdrop, one body padding and one head bar for every dialog family', () => {
  const frame = new Map(ALL.filter((d) => d.selector === 'dialog').map((d) => [d.prop, d.value]));
  assert.equal(frame.get('border-radius'), 'var(--r-xl)');
  assert.equal(frame.get('box-shadow'), 'var(--shadow-dialog)');
  assert.equal(frame.get('border-top'), '3px solid var(--accent)');
  assert.deepEqual(ALL.filter((d) => d.selector.includes('::backdrop')).map((d) => d.selector), ['dialog::backdrop']);
  // Families set their size (and the workspaces their background), never the frame; full screen on a phone is square.
  const families = /^(dialog\.[\w-]+|\.workbench|\.wb-label-manager|#create-dialog|#settings-dialog|\.viewer)$/;
  const framed = ALL.filter((d) => items(d.selector).some((i) => families.test(i)) && /^(border.*|box-shadow|padding.*|color)$/.test(d.prop) && !(d.prop === 'border-radius' && d.value === '0'));
  assert.deepEqual(framed.map((d) => `${d.file} ${d.selector} { ${d.prop}: ${d.value} }`), []);
  const body = '.ask form, .handoff-dialog form, #create-form, .workbench-form, .settings-content';
  const head = '.workbench-head, .wb-lm-head, .viewer-head, .settings-dialog .settings-head';
  const padded = (sel: string) => ALL.filter((d) => /^padding/.test(d.prop) && items(d.selector).some((i) => items(sel).includes(i))).map((d) => d.selector);
  assert.deepEqual([...new Set(padded(body))], [body]);
  assert.ok(ALL.some((d) => d.selector === '.settings-dialog .settings-content' && d.prop === 'padding' && d.value === '0'), 'the settings dialog has panes instead of a padded body');
  assert.deepEqual([...new Set(padded(head))], [head]);
});

export { ALL, declarations, type Decl };
