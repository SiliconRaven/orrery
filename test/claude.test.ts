// Native transcript discovery uses synthetic files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cutRecordHead, cutRecordTail } from '../src/adapters/claude/store.ts';
import { createClaudeNativeAdapter } from '../src/adapters/claude/native.ts';
import { tempDir } from './helpers.ts';
const FIXTURES = join(import.meta.dirname, 'fixtures', 'claude');
const FIXTURE_ID = '11111111-1111-4111-8111-000000000001';
const FIXTURE_CWD = 'C:\\fixtures\\claude-project';
// ───────────── session store ─────────────

function line(o: object) {
  return `${JSON.stringify(o)}\n`;
}
const user = (cwd: string, content: unknown, extra: object = {}) => line({ type: 'user', cwd, message: { role: 'user', content }, ...extra });
const assistant = (cwd: string, model: string) => line({ type: 'assistant', cwd, message: { model, content: [{ type: 'text', text: 'ok' }] } });
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A fake ~/.claude with a synthetic transcript plus hand-made edge cases. */
function fakeClaudeDir() {
  const dir = tempDir();
  const projects = join(dir, 'projects');
  const put = (folder: string, id: string, body: string, mtime?: Date) => {
    mkdirSync(join(projects, folder), { recursive: true });
    const file = join(projects, folder, `${id}.jsonl`);
    writeFileSync(file, body);
    if (mtime) utimesSync(file, mtime, mtime);
    return file;
  };
  put('C--fixtures-claude-project', FIXTURE_ID, readFileSync(join(FIXTURES, 'projects', 'C--fixtures-claude-project', `${FIXTURE_ID}.jsonl`), 'utf8'));
  const P = join(dir, 'proj');
  // ai-title only
  put('proj', ID(1), user(P, 'hello') + line({ type: 'ai-title', aiTitle: 'AI named it' }) + assistant(P, 'claude-x'));
  // no titles: skip meta, command wrappers and tool results; truncate the first real prompt
  put('proj', ID(2), user(P, 'meta stuff', { isMeta: true })
    + user(P, '<command-name>/clear</command-name>')
    + user(P, [{ type: 'tool_result', tool_use_id: 't', content: 'x' }])
    + user(P, [{ type: 'text', text: `first   real\nprompt ${'y'.repeat(100)}` }])
    + assistant(P, 'claude-a') + assistant(P, '<synthetic>'));
  // a worktree session filed under another folder, but whose cwd is this project
  // newer than the files written with the real current mtime (whole seconds so the ISO string round-trips)
  const newest = new Date(Math.ceil(Date.now() / 1000) * 1000 + 86_400_000);
  put('other-folder', ID(3), user(P, 'from a worktree folder'), newest);
  // the same id in two folders: listed once, the newer copy wins
  put('dup-a', ID(4), user(P, 'old copy'), new Date('2020-01-01T00:00:00Z'));
  put('dup-b', ID(4), user(P, 'new copy'), new Date('2021-01-01T00:00:00Z'));
  // no cwd anywhere: skipped; not a session id: skipped
  put('proj', ID(5), line({ type: 'custom-title', customTitle: 'orphan' }));
  put('proj', 'agent-abc', user(P, 'subagent file'));
  // big file: cwd in the head, custom title and model only in the tail
  const filler = line({ type: 'attachment', data: 'z'.repeat(1000) }).repeat(400);
  put('big', ID(6), user(join(dir, 'big'), 'big one') + filler + line({ type: 'custom-title', customTitle: 'Tail title' }) + assistant(join(dir, 'big'), 'claude-tail'));
  // big file whose first line alone exceeds the head: cwd only found in the tail
  put('huge-head', ID(7), line({ type: 'file-history-snapshot', data: 'q'.repeat(100_000) }) + filler + user(join(dir, 'hh'), 'late cwd'));
  return { dir, P, newest };
}

function snapshot(dir: string) {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort().map((f) => {
    const s = statSync(join(dir, f));
    return `${f} ${s.size} ${s.mtimeMs}`;
  });
}

test('claude store: projects grouped by the cwd inside transcripts', async () => {
  const { dir, P, newest } = fakeClaudeDir();
  const projects = await createClaudeNativeAdapter({ claudeDir: dir }).listProjects();
  const byLabel = Object.fromEntries(projects.map((p) => [p.label, p]));
  assert.deepEqual(Object.keys(byLabel).sort(), ['big', 'claude-project', 'hh', 'proj']);
  assert.equal(byLabel['claude-project'].path, FIXTURE_CWD);
  assert.equal(byLabel.proj.path, P);
  assert.equal(byLabel.proj.updatedAt, newest.toISOString(), 'newest session of the project');
  assert.equal(projects[0].label, 'proj', 'newest project first');
});

test('claude store: sessions with titles, models and edge cases; files are left untouched', async () => {
  const { dir, P } = fakeClaudeDir();
  const before = snapshot(dir);
  const adapter = createClaudeNativeAdapter({ claudeDir: dir });

  const smoke = await adapter.listSessions(FIXTURE_CWD);
  assert.deepEqual(smoke.map(({ updatedAt, ...s }) => s), [
    { id: FIXTURE_ID, title: 'Fixture conversation', model: 'claude-opus-5-5', cwd: FIXTURE_CWD },
  ]);

  const sessions = await adapter.listSessions(P);
  const title = Object.fromEntries(sessions.map((s) => [s.id, s.title]));
  assert.equal(sessions[0].id, ID(3), 'newest first');
  assert.deepEqual(Object.keys(title).sort(), [ID(1), ID(2), ID(3), ID(4)]);
  assert.equal(title[ID(1)], 'AI named it');
  assert.equal(title[ID(2)], `first real prompt ${'y'.repeat(61)}…`);
  assert.equal(title[ID(2)].length, 80);
  assert.equal(title[ID(4)], 'new copy');
  assert.equal(sessions.find((s) => s.id === ID(2))!.model, 'claude-a', 'last real assistant model');

  const [big] = await adapter.listSessions(join(dir, 'big'));
  assert.deepEqual([big.title, big.model], ['Tail title', 'claude-tail']);
  assert.equal((await adapter.listSessions(join(dir, 'hh'))).length, 1);

  assert.deepEqual((await adapter.attachSession(FIXTURE_ID)).title, 'Fixture conversation');
  await assert.rejects(adapter.attachSession(ID(99)), /not found/);
  await assert.rejects(adapter.attachSession('../../etc/passwd'), /not found/);
  assert.deepEqual(snapshot(dir), before, 'listing never writes');
});

test('claude store: duplicate ids — list and attach both use the newest readable copy', async () => {
  const dir = tempDir();
  const P = join(dir, 'p');
  const Q = join(dir, 'q');
  const put = (folder: string, body: string, mtime: Date) => {
    mkdirSync(join(dir, 'projects', folder), { recursive: true });
    const file = join(dir, 'projects', folder, `${ID(8)}.jsonl`);
    writeFileSync(file, body);
    utimesSync(file, mtime, mtime);
  };
  put('a-older', user(P, 'older copy in p'), new Date('2020-01-01T00:00:00Z'));    // listed first by readdir
  put('b-newer', user(Q, 'newer copy in q'), new Date('2021-01-01T00:00:00Z'));
  put('c-newest-unreadable', line({ type: 'custom-title', customTitle: 'no cwd' }), new Date('2022-01-01T00:00:00Z'));
  const adapter = createClaudeNativeAdapter({ claudeDir: dir });
  const attached = await adapter.attachSession(ID(8));
  assert.deepEqual([attached.cwd, attached.title], [Q, 'newer copy in q']);
  assert.deepEqual((await adapter.listSessions(Q)).map((s) => s.title), ['newer copy in q']);
  assert.deepEqual(await adapter.listSessions(P), [], 'the older copy is not listed under its own cwd');
  assert.deepEqual((await adapter.listProjects()).map((p) => p.path), [Q]);
});

test('claude store: records cut by the read window — only real top-level fields count', async () => {
  const dir = tempDir();
  const H = join(dir, 'huge');
  mkdirSync(join(dir, 'projects', 'x'), { recursive: true });
  const put = (n: number, body: string) => writeFileSync(join(dir, 'projects', 'x', `${ID(n)}.jsonl`), body);
  // Decoys: the same names inside tool inputs, behind an escaped quote, and in a nested object.
  const decoy = (tag: string) => ({ type: 'tool_use', id: tag, name: 'X', input: { model: `fake-${tag}`, customTitle: `fake-${tag}`, 'x"model': `esc-${tag}`, nested: { cwd: `/fake-${tag}` } } });
  const big = 'w'.repeat(400_000);
  const huge = (model: string, flags: object) => line({ parentUuid: 'p', ...flags, message: { model, id: 'm', type: 'message', role: 'assistant', content: [decoy('head'), { type: 'text', text: big }, decoy('tail')] }, type: 'assistant', cwd: H });
  const small = line({ type: 'user', cwd: H, message: { role: 'user', content: 'hi' } });
  // Key order as Claude writes it: isSidechain before message; cwd and type after the (huge) message.
  put(9, line({ parentUuid: null, isSidechain: false, message: { role: 'user', content: big }, type: 'user', cwd: H, sessionId: ID(9) }));
  put(10, small + huge('claude-big', { isSidechain: false }));
  put(12, small + huge('side-model', { isSidechain: true }));   // a subagent's record: never the session model
  put(13, small + huge('unowned-model', {}));                  // isSidechain not seen: ownership unknown
  // Only nested cwds, no real one: not a session.
  put(11, line({ message: { role: 'user', content: [decoy('a'), { type: 'text', text: big }, decoy('b')] }, type: 'user' }));
  // A last record still being written (no newline yet) whose cut end looks like `{…"cwd":"/fake"}`: ignored.
  put(14, line({ message: { role: 'user', content: big } }).slice(0, -3) + 'w", "x": {"cwd": "/fake-unfinished"}');
  const adapter = createClaudeNativeAdapter({ claudeDir: dir });
  assert.deepEqual((await adapter.listProjects()).map((p) => p.path), [H]);
  const byId = Object.fromEntries((await adapter.listSessions(H)).map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), [ID(9), ID(10), ID(12), ID(13)]);
  assert.deepEqual([byId[ID(10)].model, byId[ID(10)].title], ['claude-big', 'hi']);
  assert.equal(byId[ID(12)].model, null, 'sidechain record');
  assert.equal(byId[ID(13)].model, null, 'unknown ownership');
  assert.equal((await adapter.attachSession(ID(9))).cwd, H);
  await assert.rejects(adapter.attachSession(ID(11)), /not found/);
  await assert.rejects(adapter.attachSession(ID(14)), /not found/);
});

test('claude store: the cut-record scanner reads only top-level fields', () => {
  const rec = JSON.stringify({
    isSidechain: false,
    message: { model: 'real-model', role: 'assistant', content: [{ input: { model: 'tool-model', 'x"model': 'esc', customTitle: 'nope', deep: { cwd: '/nested' } } }] },
    type: 'assistant', cwd: 'C:\\real "dir"',
  });
  const cut = 60;   // inside the content
  assert.deepEqual(cutRecordHead(rec.slice(0, rec.indexOf('tool-model') + 3)), { type: 'assistant', message: { model: 'real-model' } });
  assert.deepEqual(cutRecordTail(rec.slice(cut)), { type: 'assistant', cwd: 'C:\\real "dir"' });
  assert.equal(cutRecordHead(rec.replace('"isSidechain":false', '"isSidechain":true').slice(0, 120)),
    null, 'a sidechain record yields no model (and nothing else is left)');
  assert.equal(cutRecordTail(JSON.stringify({ a: { cwd: '/nested', customTitle: 't' } }).slice(1)), null, 'nested only');
  assert.deepEqual(cutRecordTail('le":"orrery: x","sessionId":"s"}'), null, 'the title key itself is cut off');
  assert.deepEqual(cutRecordTail('x","customTitle":"orrery: x","sessionId":"s"}'), { type: 'custom-title', customTitle: 'orrery: x' });
  assert.equal(cutRecordHead('{"text":"a \\"cwd\\":\\"/esc\\" b'), null, 'an escaped key inside a string');
});

// ───────────── runTurn against the fake CLI ─────────────

const TOKEN = 'Q7zK9pL2mN4vC8cR5tW1';

/** True when no 4+ character piece of the token appears in `s`. */
function tokenFree(s: string): boolean {
  for (let i = 0; i + 4 <= TOKEN.length; i++) if (s.includes(TOKEN.slice(i, i + 4))) return false;
  return true;
}
