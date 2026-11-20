// The star map scene's pure parts (src/web/public/official-plugins/starmap/data.js, themes.js): what the Hub's data
// becomes in the sky, the satellites, the local 知道了 record, the cluster list search, the live state (snapshot plus
// stream, unread counts) and the key routing. The WebGL scene is not unit-tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const data = await import(new URL('../src/web/public/official-plugins/starmap/data.js', import.meta.url).href);
const themes = await import(new URL('../src/web/public/official-plugins/starmap/themes.js', import.meta.url).href);

const cluster = (id: string, name: string, category = '', createdAt = `2026-11-0${id.length}T00:00:00Z`) =>
  ({ id, name, category, createdAt, pinnedAt: null, archivedAt: null, userReadMessageId: null });
const member = (id: string, clusterId: string, extra: Record<string, unknown> = {}) =>
  ({ id, clusterId, name: id, harness: 'claude', status: 'online', removedAt: null, hiddenAt: null, createdAt: `2026-11-01T00:00:${id.length}0Z`, ...extra });
const notice = (id: string, systemKind: string, mentions: string[] = [], clusterId = 'c1') =>
  ({ id, clusterId, from: 'system', kind: 'system', systemKind, mentions, body: id, createdAt: `2026-11-19T00:00:0${id.length}Z` });

function stateWith(clusters: any[], members: any[], extra: Record<string, unknown> = {}) {
  const state = data.createSkyState();
  data.loadSnapshot(state, { clusters, members, settings: { clusterGroups: extra.groupOrder ?? [] }, running: extra.running ?? [] }, extra.harnesses ?? null);
  return state;
}

test('groups become galaxies in the Hub order, then by name, ungrouped last; clusters keep creation order', () => {
  const state = stateWith([
    cluster('c3', 'Gamma', 'zeta', '2026-11-03T00:00:00Z'),
    cluster('c1', 'Alpha', '研究', '2026-11-01T00:00:00Z'),
    cluster('c2', 'Beta', '', '2026-11-02T00:00:00Z'),
    cluster('c4', 'Delta', '研究', '2026-10-01T00:00:00Z'),
    cluster('c5', 'Epsilon', 'alpha', '2026-11-05T00:00:00Z'),
    { ...cluster('c6', 'Gone', '研究'), deletedAt: '2026-11-10T00:00:00Z' },
  ], [], { groupOrder: ['研究', 'empty-group'] });
  const model = data.skyModel(state);
  assert.deepEqual(model.galaxies.map((g: any) => g.name), ['研究', 'alpha', 'zeta', ''], 'listed first, an empty listed group has no galaxy');
  assert.deepEqual(model.galaxies[0].systems.map((s: any) => s.cluster.id), ['c4', 'c1'], 'oldest first, the deleted one is not in the sky');
  assert.equal(model.galaxies[3].ungrouped, true);
  assert.ok(model.systems.has('c2') && !model.systems.has('c6'));
});

test('members become planets with the page status: online, busy, offline and hidden', () => {
  const state = stateWith([cluster('c1', 'A')], [
    member('idle', 'c1'),
    member('busyByRunning', 'c1'),
    member('busyByStatus', 'c1', { status: 'busy' }),
    member('off', 'c1', { status: 'offline' }),
    member('noApp', 'c1', { harness: 'gone' }),
    member('ghost', 'c1', { hiddenAt: '2026-11-18T00:00:00Z' }),
    member('removed', 'c1', { removedAt: '2026-11-18T00:00:00Z' }),
  ], { running: [{ id: 'd1', memberId: 'busyByRunning' }], harnesses: ['claude'] });
  const planets = data.skyModel(state).systems.get('c1').planets;
  const by = Object.fromEntries(planets.map((p: any) => [p.member.id, [p.status, p.hidden]]));
  assert.deepEqual(by, {
    idle: ['online', false], busyByRunning: ['busy', false], busyByStatus: ['busy', false], off: ['offline', false],
    noApp: ['offline', false], ghost: ['online', true],
  });
  const stats = data.skyModel(state).systems.get('c1').stats;
  assert.deepEqual([stats.n, stats.busy, stats.online, stats.offline, stats.hidden], [6, 2, 3, 2, 1], 'online counts busy ones too, without the hidden (as the chat header does)');
});

test('satellites are warnings not dismissed: one recipient orbits its planet, others the star', () => {
  const messages = [
    notice('m1', 'delivery_failed', ['a']),
    notice('m2', 'task_rejected', ['a', 'b']),
    notice('m3', 'task', ['a']),
    notice('m4', 'stalled', []),
    { id: 'm5', clusterId: 'c1', from: 'a', kind: 'chat', mentions: [], body: 'hi', createdAt: '2026-11-19T00:00:05Z' },
    notice('m6', 'quota_low', ['a']),
  ];
  const sats = data.satellitesOf(messages, new Set(['m6']));
  assert.deepEqual(sats.map((s: any) => [s.id, s.level, s.target]), [['m1', 'problem', 'a'], ['m2', 'attention', null], ['m4', 'attention', null]]);
  assert.deepEqual(data.satellitesOf(messages).length, 4, 'nothing dismissed by default');
  // In the sky, a notice for a member who is not a planet (removed) circles the star instead.
  const state = stateWith([cluster('c1', 'A')], [member('b', 'c1')]);
  data.setMessages(state, 'c1', messages);
  const system = data.skyModel(state, () => new Set()).systems.get('c1');
  assert.equal(system.satellites.find((s: any) => s.id === 'm1').target, null);
  assert.equal(system.stats.level, 'problem');
  assert.equal(data.skyModel(state, () => new Set(['m1', 'm6'])).systems.get('c1').stats.level, 'attention');
});

test('the dismissed record is per Hub and cluster, deduplicated, capped (oldest dropped) and survives bad storage', () => {
  let list = data.addDismissed([], 'hubA', 'c1', ['m1', 'm2'], 1);
  list = data.addDismissed(list, 'hubB', 'c1', ['m1'], 2);
  list = data.addDismissed(list, 'hubA', 'c1', ['m1'], 3);
  assert.deepEqual([...data.dismissedSet(list, 'hubA', 'c1')].sort(), ['m1', 'm2']);
  assert.deepEqual([...data.dismissedSet(list, 'hubA', 'c2')], []);
  assert.equal(list.length, 3, 'one record per notice');
  assert.equal(list.at(-1).id, 'm1', 'hidden again: now the newest');
  const capped = data.addDismissed(list, 'hubA', 'c1', ['m3', 'm4'], 4, 3);
  assert.deepEqual(capped.map((r: any) => r.id), ['m1', 'm3', 'm4'], 'the oldest records go first');
  assert.deepEqual(data.parseDismissed(data.serializeDismissed(capped)), capped);
  for (const raw of [null, '', 'not json', '{}', '[["a","b"]]', '[[1,2,3,4]]']) assert.deepEqual(data.parseDismissed(raw), [], String(raw));

  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
  const store = data.dismissedStore(storage, 'hubA');
  store.add('c1', ['x']);
  assert.deepEqual([...data.dismissedStore(storage, 'hubA').of('c1')], ['x'], 'kept across stores');
  assert.deepEqual([...data.dismissedStore(storage, 'hubB').of('c1')], [], 'another Hub sees none');
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const memoryOnly = data.dismissedStore(blocked, 'hubA');
  assert.deepEqual([...memoryOnly.of('c1')], []);
  memoryOnly.add('c1', ['y']);
  assert.deepEqual([...memoryOnly.of('c1')], ['y'], 'blocked storage: the choice lasts this visit');
});

test('the cluster list ranks own names, then groups, then members; Enter starts on a member when only members matched', () => {
  const state = stateWith([
    cluster('c1', 'orrery-docs', 'orrery', '2026-11-01T00:00:00Z'),
    cluster('c2', 'Docs', '', '2026-11-02T00:00:00Z'),
    cluster('c3', 'docs team', '', '2026-11-03T00:00:00Z'),
    cluster('c4', 'Website', 'docs', '2026-11-04T00:00:00Z'),
    cluster('c5', 'Ops', '', '2026-11-05T00:00:00Z'),
  ], [member('docs-bot', 'c5'), member('kimi', 'c5', { harness: 'kimi' }), member('writer', 'c3')]);
  const model = data.skyModel(state);
  const names = (r: any) => (r.type === 'trash' ? '[trash]' : r.type === 'member' ? `  ${r.planet.member.name}` : r.system.cluster.name);

  const docs = data.searchSky(model, '  DOCS ');
  assert.deepEqual(docs.rows.map(names), ['Docs', 'docs team', 'orrery-docs', 'Website', 'Ops', '  docs-bot']);
  assert.equal(docs.active, 0);

  const bot = data.searchSky(model, 'bot');
  assert.deepEqual(bot.rows.map(names), ['Ops', '  docs-bot']);
  assert.equal(bot.active, 1, 'only a member matched: Enter opens it');

  assert.deepEqual(data.searchSky(model, 'kimi code').rows.map(names), ['Ops', '  kimi'], 'by harness name');
  assert.deepEqual(data.searchSky(model, '回收').rows.map(names), ['[trash]']);
  assert.deepEqual(data.searchSky(model, 'tra', 'Trash').rows.map(names), ['[trash]'], 'in the page language too');
  assert.deepEqual(data.searchSky(model, 'nothing').rows, []);

  const all = data.searchSky(model, '');
  assert.equal(all.rows.length, 6);
  assert.deepEqual(all.rows.map((r: any) => r.group ?? null), ['docs', 'orrery', '', '', '', null], 'sky order with group names for headings');
});

test('layout is deterministic, keeps galaxies apart and puts the black hole outside them', () => {
  const state = stateWith(['a', 'b', 'c', 'd', 'e', 'f'].map((g, i) => cluster(`c${i}`, g, i === 5 ? '' : g)), []);
  const model = data.skyModel(state);
  const one = data.layoutSky(model.galaxies);
  assert.deepEqual(data.layoutSky(model.galaxies), one);
  assert.deepEqual(one.galaxies.map((g: any) => g.type).at(-1), 'cloud', 'the ungrouped galaxy is a loose cloud');
  const dist = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  for (const [i, g] of one.galaxies.entries()) {
    for (const h of one.galaxies.slice(i + 1)) assert.ok(dist(g.pos, h.pos) > g.R + h.R, `${g.name} and ${h.name} overlap`);
    assert.ok(dist(g.pos, one.blackHole) > g.R + 80, `${g.name} is too near the black hole`);
    for (const s of g.systems) assert.ok(Math.hypot(...s.local) < g.R, 'systems inside their galaxy');
  }
  assert.deepEqual(data.orbitFractions(1), [0.6]);
  assert.deepEqual(data.orbitFractions(3).map((f: number) => +f.toFixed(6)), [0.36, 0.66, 0.96]);
});

test('live events: members, deliveries, messages, settings and the recycle bin', () => {
  const state = stateWith([cluster('c1', 'A'), cluster('c2', 'B')], [member('a', 'c1')]);
  data.setMessages(state, 'c1', []);
  assert.equal(data.applySkyEvent(state, { kind: 'agent', payload: {} }), null);
  assert.equal(data.applySkyEvent(state, { kind: 'delivery', payload: { delivery: { id: 'd1', memberId: 'a', state: 'running' } } }).status, true);
  assert.equal(data.skyModel(state).systems.get('c1').planets[0].status, 'busy');
  data.applySkyEvent(state, { kind: 'delivery', payload: { delivery: { id: 'd1', memberId: 'a', state: 'done' } } });
  assert.equal(data.skyModel(state).systems.get('c1').planets[0].status, 'online');

  const change = data.applySkyEvent(state, { kind: 'message', payload: { message: notice('n1', 'delivery_failed', ['a']), deliveries: [] } });
  assert.deepEqual(change.notices, ['c1']);
  assert.equal(data.skyModel(state).systems.get('c1').satellites.length, 1);
  data.applySkyEvent(state, { kind: 'message', payload: { message: notice('n2', 'delivery_failed', [], 'c2'), deliveries: [] } });
  assert.ok(!state.messages.has('c2'), 'a cluster whose messages were never read keeps none (its page read brings them)');

  data.applySkyEvent(state, { kind: 'member', payload: { member: member('b', 'c1') } });
  data.applySkyEvent(state, { kind: 'member', payload: { member: { ...member('a', 'c1'), removedAt: 'x' } } });
  assert.deepEqual(data.skyModel(state).systems.get('c1').planets.map((p: any) => p.member.id), ['b']);

  data.applySkyEvent(state, { kind: 'settings', payload: { clusterGroups: ['g'] } });
  assert.deepEqual(state.groupOrder, ['g']);

  const trashed = data.applySkyEvent(state, { kind: 'cluster', payload: { cluster: { ...cluster('c1', 'A'), deletedAt: 'now' }, members: [] } });
  assert.equal(trashed.trash, true);
  assert.ok(!data.skyModel(state).systems.has('c1') && state.members.size === 0 && !state.messages.has('c1'));
  const back = data.applySkyEvent(state, { kind: 'cluster', payload: { cluster: cluster('c1', 'A'), members: [] } });
  assert.equal(back.reload, true, 'restored without members: read the state again');

  const before = data.skyKey(data.skyModel(state));
  data.applySkyEvent(state, { kind: 'delivery', payload: { delivery: { id: 'd2', memberId: 'b', state: 'running' } } });
  assert.equal(data.skyKey(data.skyModel(state)), before, 'a status change does not move the sky');
});

const msg = (id: string, from: string, clusterId = 'c1', createdAt = `2026-11-19T01:00:0${id.length}Z`) => ({ id, clusterId, from, kind: 'chat', body: id, mentions: [], createdAt });
const frame = (seq: number, kind: string, payload: Record<string, unknown>) => ({ seq, kind, payload });
const snapshotOf = (seq: number, clusters: any[], members: any[], running: any[] = []) => ({ seq, clusters, members, settings: { clusterGroups: [] }, running });

test('frames streamed while the first snapshot is read are applied after it, only the newer ones', () => {
  const state = data.createSkyState();
  // In the order they arrived: one already in the snapshot (seq 9), two after it (11, 12).
  const kept = [
    frame(9, 'member', { member: { ...member('old', 'c1'), removedAt: 'x' } }),
    frame(11, 'member', { member: member('late', 'c1') }),
    frame(12, 'delivery', { delivery: { id: 'd1', memberId: 'a', state: 'running' } }),
  ];
  const changes = data.loadSnapshot(state, snapshotOf(10, [cluster('c1', 'A')], [member('a', 'c1'), member('old', 'c1')]), null, kept);
  assert.equal(changes.length, 2, 'the frame the snapshot already holds changes nothing');
  assert.equal(state.seq, 12);
  const planets = data.skyModel(state).systems.get('c1').planets;
  assert.deepEqual(planets.map((p: any) => p.member.id).sort(), ['a', 'late', 'old'], 'seq 9 is older than the snapshot: old stays');
  assert.equal(planets.find((p: any) => p.member.id === 'a').status, 'busy');
  assert.equal(data.applySkyEvent(state, kept[1]), null, 'a frame is applied once');
});

test('a re-snapshot older than frames applied meanwhile keeps them; a newer one is not counted twice', () => {
  const state = data.createSkyState();
  data.loadSnapshot(state, snapshotOf(10, [{ ...cluster('c1', 'A'), unread: 1 }], [member('a', 'c1')]));
  // Applied live while the next snapshot is read (and kept for it).
  const kept = [
    frame(11, 'member', { member: { ...member('a', 'c1'), name: 'renamed' } }),
    frame(12, 'delivery', { delivery: { id: 'd1', memberId: 'a', state: 'running' } }),
    frame(13, 'message', { message: msg('m1', 'a'), deliveries: [] }),
  ];
  for (const f of kept) data.applySkyEvent(state, f);
  assert.equal(state.clusters.get('c1').unread, 2);
  // The snapshot was read at seq 11: it has the rename but not the delivery or the message.
  data.loadSnapshot(state, snapshotOf(11, [{ ...cluster('c1', 'A'), unread: 1 }], [{ ...member('a', 'c1'), name: 'renamed' }]), null, kept);
  assert.equal(state.members.get('a').name, 'renamed');
  assert.equal(data.skyModel(state).systems.get('c1').planets[0].status, 'busy', 'the newer delivery is not lost');
  assert.equal(state.clusters.get('c1').unread, 2, 'the newer message is counted over the snapshot');
  // A stale snapshot from before the rename: the kept rename is applied again.
  data.loadSnapshot(state, snapshotOf(10, [{ ...cluster('c1', 'A'), unread: 1 }], [member('a', 'c1')]), null, kept);
  assert.equal(state.members.get('a').name, 'renamed');
  // A snapshot read after all of them already counts the message.
  data.loadSnapshot(state, snapshotOf(13, [{ ...cluster('c1', 'A'), unread: 2 }], [member('a', 'c1')], [{ id: 'd1', memberId: 'a' }]), null, kept);
  assert.equal(state.clusters.get('c1').unread, 2);
  assert.equal(state.seq, 13);
});

test('replaying a read move and a new message over a re-read snapshot counts the message once (review r2)', () => {
  const state = data.createSkyState();
  data.loadSnapshot(state, snapshotOf(10, [{ ...cluster('c1', 'A'), unread: 1 }], [member('a', 'c1')]));
  data.setMessages(state, 'c1', [msg('a', 'a')]);
  // Live: the user reads up to a (seq 11), then b arrives from a member (seq 12).
  const kept = [
    frame(11, 'cluster', { cluster: { ...cluster('c1', 'A'), userReadMessageId: 'a' }, members: [] }),
    frame(12, 'message', { message: msg('bb', 'a'), deliveries: [] }),
  ];
  for (const f of kept) data.applySkyEvent(state, f);
  assert.equal(state.clusters.get('c1').unread, 1);
  // The re-read snapshot is still seq 10 (a unread): replaying both frames ends where the live state was.
  data.loadSnapshot(state, snapshotOf(10, [{ ...cluster('c1', 'A'), unread: 1 }], [member('a', 'c1')]), null, kept);
  assert.equal(state.clusters.get('c1').unread, 1, 'b counted once, a read');
  assert.deepEqual(state.messages.get('c1').map((m: any) => m.id), ['a', 'bb'], 'the held messages are the same');
  // Without a read move, the replayed message still counts over the snapshot.
  const state2 = data.createSkyState();
  data.loadSnapshot(state2, snapshotOf(10, [{ ...cluster('c1', 'A'), unread: 1 }], [member('a', 'c1')]));
  data.setMessages(state2, 'c1', [msg('a', 'a')]);
  data.applySkyEvent(state2, kept[1]);
  data.loadSnapshot(state2, snapshotOf(10, [{ ...cluster('c1', 'A'), unread: 1 }], [member('a', 'c1')]), null, [kept[1]]);
  assert.equal(state2.clusters.get('c1').unread, 2);
});

test('unread counts follow new messages and the read position, as the Hub counts them', () => {
  const state = data.createSkyState();
  data.loadSnapshot(state, snapshotOf(10, [{ ...cluster('c1', 'A'), unread: 0 }], [member('a', 'c1')]));
  data.setMessages(state, 'c1', [msg('m1', 'a'), msg('m22', 'user')]);
  let change = data.applySkyEvent(state, frame(11, 'message', { message: msg('m333', 'a'), deliveries: [] }));
  assert.equal(change.unread, true);
  change = data.applySkyEvent(state, frame(12, 'message', { message: msg('m4444', 'user'), deliveries: [] }));
  assert.equal(change.unread, false, 'the user’s own messages are not unread');
  assert.equal(state.clusters.get('c1').unread, 1);
  data.applySkyEvent(state, frame(13, 'message', { message: msg('m55555', 'system'), deliveries: [] }));
  assert.equal(state.clusters.get('c1').unread, 2, 'system messages count, as in Store.unreadCounts');

  // The user read up to m333 (on this or another page): counted again from the messages held here.
  change = data.applySkyEvent(state, frame(14, 'cluster', { cluster: { ...cluster('c1', 'A'), userReadMessageId: 'm333' }, members: [] }));
  assert.equal(change.unread, true);
  assert.equal(change.recount, false);
  assert.equal(state.clusters.get('c1').unread, 1, 'only m55555 is after it and not from the user');
  // Moved to a message not held here: the count stays until the Hub counts it (a fresh /api/state).
  change = data.applySkyEvent(state, frame(15, 'cluster', { cluster: { ...cluster('c1', 'A'), userReadMessageId: 'elsewhere' }, members: [] }));
  assert.equal(change.recount, true);
  assert.equal(state.clusters.get('c1').unread, 1);
  // A rename keeps the count and the read position.
  change = data.applySkyEvent(state, frame(16, 'cluster', { cluster: { ...cluster('c1', 'B'), userReadMessageId: 'elsewhere' }, members: [] }));
  assert.equal(change.recount, false);
  assert.equal(state.clusters.get('c1').unread, 1);
});

test('keys: shortcuts only from the sky, Esc one level at a time and left to the host at the top', () => {
  const sky = { where: 'sky', typing: false, open: null, top: false };
  const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, mod: false, alt: false, ...extra });
  assert.equal(data.keyAction(key('/'), sky), 'finder-open');
  assert.equal(data.keyAction(key('k', { mod: true }), sky), 'finder-toggle');
  assert.equal(data.keyAction(key('K', { mod: true }), { ...sky, typing: true }), 'finder-toggle', 'Ctrl+K also from the list input');
  assert.equal(data.keyAction(key('k', { mod: true, alt: true }), sky), null);
  assert.equal(data.keyAction(key('f'), sky), 'hud');
  assert.equal(data.keyAction(key('F', { mod: true }), sky), null);
  assert.equal(data.keyAction(key('/'), { ...sky, typing: true }), null, 'typed into a field');
  assert.equal(data.keyAction(key('f'), { ...sky, typing: true }), null);

  assert.equal(data.keyAction(key('Escape'), sky), 'up');
  assert.equal(data.keyAction(key('Escape'), { ...sky, top: true }), null, 'at the universe the host closes the view');
  for (const open of ['finder', 'ncard', 'help', 'menu']) assert.equal(data.keyAction(key('Escape'), { ...sky, top: true, open }), 'close');
  assert.equal(data.keyAction(key('Escape'), { ...sky, top: true, typing: true }), 'leave', 'a draft never closes the star map');

  for (const k of ['/', 'f', 'Escape']) assert.equal(data.keyAction(key(k), { ...sky, where: 'outside' }), null, `${k} in the sidebar or a host dialog`);
  assert.equal(data.keyAction(key('k', { mod: true }), { ...sky, where: 'outside' }), null);
  for (const k of ['/', 'f']) assert.equal(data.keyAction(key(k), { ...sky, where: 'window' }), null, `${k} in a chat window is its own`);
  assert.equal(data.keyAction(key('k', { mod: true }), { ...sky, where: 'window' }), null);
  assert.equal(data.keyAction(key('Escape'), { ...sky, where: 'window', top: true }), 'leave', 'Esc in a chat window goes back to the sky, not out of the view');
});

test('setMessages keeps the newest page merged with streamed messages', () => {
  const state = data.createSkyState();
  const many = Array.from({ length: 130 }, (_, i) => ({ id: `m${i}`, clusterId: 'c', createdAt: new Date(Date.UTC(2026, 10, 19, 0, 0, i)).toISOString() }));
  data.setMessages(state, 'c', many.slice(0, 120));
  data.setMessages(state, 'c', many.slice(110));
  const kept = state.messages.get('c');
  assert.equal(kept.length, data.MESSAGES_KEPT);
  assert.equal(kept.at(-1).id, 'm129');
  assert.equal(kept[0].id, 'm30');
});

test('themes: three complete tables, luna by default, unknown or blocked storage falls back', () => {
  assert.deepEqual(Object.keys(themes.THEMES), themes.THEME_ORDER);
  const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keys(v).map((x) => `${k}.${x}`) : [k])).sort();
  for (const name of themes.THEME_ORDER) assert.deepEqual(keys(themes.THEMES[name]), keys(themes.THEMES.luna), name);
  assert.equal(themes.readTheme(null), 'luna');
  assert.equal(themes.readTheme({ getItem: () => 'sol' }), 'sol');
  assert.equal(themes.readTheme({ getItem: () => 'neon' }), 'luna');
  assert.equal(themes.readTheme({ getItem() { throw new Error('blocked'); } }), 'luna');
  assert.doesNotThrow(() => themes.saveTheme({ setItem() { throw new Error('blocked'); } }, 'sol'));
  assert.deepEqual(Object.keys(themes.THEME_ICON), themes.THEME_ORDER);
});
