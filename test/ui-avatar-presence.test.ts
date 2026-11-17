// A member's avatar on its orbit (ui.js avatarEl with presence; docs/architecture.md「网页的图标、空状态和在线圈」): a ring
// and the state's dot, a class per state, offline hollow (CSS), the state in words, and the app badge left as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

const PUB = join(REPO_ROOT, 'src', 'web', 'public');
const ui = await import(pathToFileURL(join(PUB, 'ui.js')).href);

type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[]; on: Record<string, unknown>;
  setAttribute(k: string, v: string): void; addEventListener(k: string, f: unknown): void; append(...c: (El | string)[]): void };
const make = (tag: string): El => ({ tag, attrs: {}, kids: [], on: {},
  setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.on[k] = f; }, append(...c) { this.kids.push(...c); } });

test('avatar presence: the orbit wraps the same avatar, a dot per state, the state in the tooltip and (named) the name', (t) => {
  const prev = (globalThis as any).document;
  (globalThis as any).document = { createElement: make, createElementNS: (_: string, tag: string) => make(tag) };
  t.after(() => { (globalThis as any).document = prev; });
  const claude = { name: 'opus', harness: 'claude', avatar: null, mode: 'native' };

  for (const [status, label] of [['idle', '空闲'], ['busy', '投递通道占用'], ['offline', '离线']]) {
    const presence = ui.memberPresence(claude, status);
    assert.deepEqual(presence, { state: status, label });
    const orbit = ui.avatarEl(claude, 'sm', { presence }) as El;
    assert.deepEqual([orbit.tag, orbit.attrs.class], ['span', `avatar-orbit sm presence-${status}`], 'one state class');
    assert.equal(orbit.attrs.title, `opus · ${label}`, 'not colour alone: the tooltip says the state');
    assert.equal(orbit.attrs['aria-label'], undefined, 'beside the name and the state words: not read twice');
    const [face, dot] = orbit.kids as El[];
    // The avatar inside is exactly the one without presence, minus its own tooltip (the orbit carries it).
    const plain = ui.avatarEl(claude, 'sm') as El;
    assert.equal(face.attrs.class, plain.attrs.class);
    assert.equal(face.attrs.class, `avatar sm app ${ui.APP_AVATAR_MARK}`, 'the app icon avatar and its mark (badge or ring) unchanged');
    assert.equal(face.attrs.title, undefined);
    assert.deepEqual([dot.tag, dot.attrs.class, dot.attrs['aria-hidden']], ['span', 'presence-dot', 'true']);
    assert.equal(orbit.kids.length, 2);
    if (ui.APP_AVATAR_MARK === 'badge') {
      assert.deepEqual((face.kids[1] as El).attrs, { class: 'avatar-mark', 'aria-hidden': 'true' }, 'the badge is still the avatar\'s own child');
    }
  }
  // Shown without a name beside it (the header's stack): the accessible name carries the state too.
  const named = ui.avatarEl(claude, 'sm', { named: true, presence: ui.memberPresence(claude, 'offline') }) as El;
  assert.deepEqual([named.attrs.role, named.attrs['aria-label']], ['img', 'opus，离线']);
  // Without presence nothing changes: the avatar itself, named by itself.
  const bare = ui.avatarEl(claude, 'sm', { named: true }) as El;
  assert.deepEqual([bare.attrs.class, bare.attrs.role, bare.attrs['aria-label'], bare.attrs.title], [`avatar sm app ${ui.APP_AVATAR_MARK}`, 'img', 'opus', 'opus']);
  // Other kinds of avatar sit on the orbit the same way.
  const emoji = ui.avatarEl({ name: 'fox', harness: 'mock', avatar: '🦊' }, '', { presence: { state: 'busy', label: '处理中' } }) as El;
  assert.deepEqual([emoji.attrs.class, (emoji.kids[0] as El).attrs.class], ['avatar-orbit presence-busy', 'avatar  emoji']);
});

test('avatar presence: the styles put the dot on the ring at the upper right, hollow when offline, colours from the state tokens', () => {
  const css = readFileSync(join(PUB, 'style.css'), 'utf8');
  const rule = (sel: string) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  assert.match(rule('.avatar-orbit.presence-idle'), /--presence: var\(--done\)/);
  assert.match(rule('.avatar-orbit.presence-busy'), /--presence: var\(--running\)/);
  assert.match(css, /\.avatar-orbit \{\s*--presence: var\(--muted\)/, 'offline: muted');
  assert.match(rule('.presence-offline > .presence-dot'), /background: var\(--surface\); box-shadow: inset 0 0 0 1\.5px var\(--presence\)/, 'offline is a hollow dot');
  const dot = rule('.presence-dot');
  assert.match(dot, /left: calc\(50% \+ \(50% \+ \.5px\) \* \.7071 - var\(--dot\) \/ 2\); top: calc\(50% - \(50% \+ \.5px\) \* \.7071/, 'on the ring at 45°, upper right');
  assert.match(css, /\.avatar\.app\.badge > \.avatar-mark \{\s*--m: [^;]+; position: absolute; right: -3px; bottom: -3px;/, 'the badge keeps the lower right');
  assert.doesNotMatch(css, /\.member-stack [^{]*\.avatar-mark/, 'the stack no longer moves the badge: earlier avatars lie on top');
  // Every place that shows a member with a state uses the one avatarEl option, not its own dot.
  const app = readFileSync(join(PUB, 'app.js'), 'utf8');
  for (const re of [/avatarEl\(m, 'sm', \{ named: true, presence: presenceOf\(m\) \}\)/, /avatarEl\(m, 'sm', \{ presence: presenceOf\(m\) \}\)/,
    /avatarEl\(m, 'lg', \{ presence: removed \? null : presenceOf\(m\) \}\)/]) assert.match(app, re);
  // Only where the page redraws on member status events (app.js render() after every event); the workbench does not, so
  // its member cards show the plain avatar rather than a dot that could go stale.
  const wb = readFileSync(join(PUB, 'workbench.js'), 'utf8');
  assert.match(wb, /h\('span', \{ class: 'wb-member' \}, avatarEl\(member, 'sm'\), /);
  assert.doesNotMatch(wb, /presenceOf|presence: /, 'no orbit in the workbench (its wb-presence chip is the activity observer, a different thing)');
  assert.doesNotMatch(app, /createWorkbench\([\s\S]{0,800}presenceOf/);
  assert.doesNotMatch(app, /status-dot \$\{statusOf\(m\)\}/, 'the member row\'s separate dot is gone; its word stays');
});
