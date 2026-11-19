import { strict as assert } from 'node:assert';
import { appendFile, link, mkdir, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { zstdCompressSync, zstdDecompress } from 'node:zlib';
import { readTranscriptPage, TRANSCRIPT_LINE_BYTES, TRANSCRIPT_ZSTD_INPUT_BYTES, TRANSCRIPT_ZSTD_OUTPUT_BYTES,
  type TranscriptDraft } from '../src/adapters/shared/transcript.ts';
import { TRANSCRIPT_MAX_ITEMS, TRANSCRIPT_TEXT_BYTES, type TranscriptRequest } from '../src/core/native-transcript.ts';
import { junction } from './extensions-fixture.ts';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'sessions');
  await mkdir(root);
  const file = join(root, 'literal-session-path.jsonl');
  const parse = (value: unknown): TranscriptDraft[] | undefined => {
    if (typeof value === 'string') return [{ kind: 'user', text: value }];
    if (Array.isArray(value)) return value.map(text => ({ kind: 'assistant', text: String(text) }));
    return undefined;
  };
  const options = { root, file, sessionKey: 'literal-session-key', parse, unknownText: 'Unrecognized record.' };
  return { dir, root, file, options, page: (request: TranscriptRequest = {}) => readTranscriptPage({ ...options, request }) };
}

test('latest, older and appended records resume inside multi-item rows', async t => {
  const { file, page } = await fixture(t);
  await writeFile(file, '"old"\r\n["a","b","c"]\n"current"\n');
  const newest = await page({ limit: 2 });
  assert.deepEqual(newest.items.map(i => i.text), ['c', 'current']);
  assert.equal(newest.hasMore, true);
  const previous = await page({ limit: 2, cursor: newest.before });
  assert.deepEqual(previous.items.map(i => i.text), ['a', 'b']);
  const replay = await page({ limit: 2, cursor: previous.after, direction: 'after' });
  assert.deepEqual(replay.items, newest.items);
  const oldest = await page({ limit: 2, cursor: previous.before });
  assert.deepEqual(oldest.items.map(i => i.text), ['old']);
  assert.equal(oldest.before, undefined);
  assert.equal(oldest.hasMore, false);
  await appendFile(file, '["d","e","f"]\n');
  const update = await page({ direction: 'after', cursor: newest.after, limit: 2 });
  assert.deepEqual(update.items.map(i => i.text), ['d', 'e']);
  assert.equal(update.hasMore, true);
  const last = await page({ direction: 'after', cursor: update.after });
  assert.deepEqual(last.items.map(i => i.text), ['f']);
  assert.equal(last.hasMore, false);
});

test('an empty page gets a cursor and an incomplete UTF-8 line appears once after append', async t => {
  const { file, page } = await fixture(t);
  await writeFile(file, '');
  const empty = await page();
  assert.equal(empty.status, 'ok');
  assert.ok(empty.after);
  const encoded = Buffer.from('"你好"\n');
  await appendFile(file, encoded.subarray(0, 2));
  const pending = await page({ direction: 'after', cursor: empty.after });
  assert.deepEqual(pending.items, []);
  assert.equal(pending.hasMore, false);
  await appendFile(file, encoded.subarray(2));
  const completed = await page({ direction: 'after', cursor: pending.after });
  assert.deepEqual(completed.items.map(i => i.text), ['你好']);
  assert.deepEqual((await page({ direction: 'after', cursor: completed.after })).items, []);
});

test('scan-window cuts preserve records on both sides of an oversized line', async t => {
  const { file, page } = await fixture(t);
  await writeFile(file, '"older"\n');
  const start = await page();
  await appendFile(file, `${'x'.repeat(2 * 1024 * 1024 + 11)}\n"newer"\n`);
  const backwards = [] as string[];
  let before: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await page({ cursor: before });
    assert.equal(result.status, 'ok');
    backwards.unshift(...result.items.map(i => i.text!));
    before = result.before;
    if (!result.hasMore) break;
    assert.ok(before);
  }
  const forwards = [] as string[];
  let after = start.after;
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await page({ direction: 'after', cursor: after });
    assert.equal(result.status, 'ok');
    forwards.push(...result.items.map(i => i.text!));
    after = result.after;
    if (!result.hasMore) break;
  }
  assert.deepEqual(backwards, ['older', 'Unrecognized record.', 'newer']);
  assert.deepEqual(forwards, backwards.slice(1));
});

test('a huge unfinished tail does not hide an older record or publish a bad row early', async t => {
  const { file, page } = await fixture(t);
  await writeFile(file, `"complete"\n${'p'.repeat(2 * 1024 * 1024 + 11)}`);
  const latest = await page();
  assert.equal(latest.hasMore, true);
  assert.deepEqual(latest.items, []);
  const older = await page({ cursor: latest.before });
  const oldest = await page({ cursor: older.before });
  assert.deepEqual(oldest.items.map(i => i.text), ['complete']);
  assert.equal(oldest.hasMore, false);
  assert.deepEqual((await page({ direction: 'after', cursor: latest.after })).items, []);
  await appendFile(file, '\n"next"\n');
  const update = await page({ direction: 'after', cursor: latest.after });
  assert.deepEqual(update.items.map(i => i.text), ['Unrecognized record.', 'next']);
});

test('malformed rows are isolated, previews preserve UTF-8, and the item count is capped', async t => {
  const { file, page } = await fixture(t);
  const long = `${'a'.repeat(TRANSCRIPT_TEXT_BYTES - 1)}界`;
  await writeFile(file, `${'"repeated"\n'.repeat(TRANSCRIPT_MAX_ITEMS)}malformed-private-text\n${JSON.stringify(long)}\n`);
  const result = await page({ limit: 9999 });
  assert.equal(result.items.length, TRANSCRIPT_MAX_ITEMS);
  assert.equal(result.unknownCount, 1);
  assert.equal(result.items.at(-2)?.text, 'Unrecognized record.');
  assert.equal(result.items.at(-1)?.text, 'a'.repeat(TRANSCRIPT_TEXT_BYTES - 1));
  assert.equal(result.items.at(-1)?.truncated, true);
  const cursorBody = Buffer.from(result.after!.split('.')[0]!, 'base64url').toString('utf8');
  assert.doesNotMatch(cursorBody, /literal-session|malformed-private-text|repeated/);
});

test('repeated explicit IDs retain the newest physical item within each page', async t => {
  const { file, options } = await fixture(t);
  await writeFile(file, '"draft"\n"intervening"\n"final"\n');
  const result = await readTranscriptPage({ ...options, request: {}, parse: value => [{ kind: 'assistant',
    text: String(value), id: value === 'intervening' ? 'other' : 'shared' }] });
  assert.deepEqual(result.items.map(i => i.text), ['intervening', 'final']);
});

test('tampered and cross-session cursors, in-place rewrites, truncation and replacement reset', async t => {
  const { file, options, page } = await fixture(t);
  await writeFile(file, '"original"\n');
  const start = (await page()).after!;
  const poll = (cursor: string) => page({ direction: 'after', cursor });
  assert.equal((await poll(`x${start.slice(1)}`)).status, 'reset');
  assert.equal((await readTranscriptPage({ ...options, sessionKey: 'other', request: { cursor: start } })).status, 'reset');
  await writeFile(file, '"replaced"\n');
  assert.equal((await poll(start)).status, 'reset');
  const changed = (await page()).after!;
  await writeFile(file, '"modified and longer"\n');
  assert.equal((await poll(changed)).status, 'reset');
  const longer = (await page()).after!;
  await truncate(file, 0);
  assert.equal((await poll(longer)).status, 'reset');
  const empty = (await page()).after!;
  await rename(file, `${file}.old`);
  await writeFile(file, '');
  assert.equal((await poll(empty)).status, 'reset');
});

test('containment and file identity reject outside paths and hard links', async t => {
  const { dir, file, options, page } = await fixture(t);
  assert.equal((await page()).status, 'missing');
  const outsideDir = join(dir, 'outside');
  const outsideFile = join(outsideDir, 'other.jsonl');
  await mkdir(outsideDir);
  await writeFile(outsideFile, '"foreign record"\n');
  assert.equal((await readTranscriptPage({ ...options, file: outsideFile, request: {} })).status, 'refused');
  await link(outsideFile, file);
  assert.equal((await page()).status, 'refused');
});

test('junctions cannot alias another transcript inside or outside the root', async t => {
  const { dir, root, options } = await fixture(t);
  const outsideDir = join(dir, 'outside');
  await mkdir(outsideDir);
  await writeFile(join(outsideDir, 'other.jsonl'), '"foreign record"\n');
  const aliased = join(root, 'aliased');
  if (!junction(outsideDir, aliased)) return t.skip('the OS refused to create a junction');
  assert.equal((await readTranscriptPage({ ...options, file: join(aliased, 'other.jsonl'), request: {} })).status, 'refused');
  const inside = join(root, 'other');
  await mkdir(inside);
  await writeFile(join(inside, 'other.jsonl'), '"other session"\n');
  const insideAlias = join(root, 'alias-inside');
  assert.equal(junction(inside, insideAlias), true);
  assert.equal((await readTranscriptPage({ ...options, file: join(insideAlias, 'other.jsonl'), request: {} })).status, 'refused');
});

test('an in-memory zstd archive uses the same pagination and has bounded fallback', async t => {
  const { file, options } = await fixture(t);
  await writeFile(file, zstdCompressSync(Buffer.from('"header"\n"body"\n')));
  let decoded = 0;
  const unzstd = promisify(zstdDecompress);
  const decompress = (input: Buffer) => {
    decoded++;
    return unzstd(input, { maxOutputLength: TRANSCRIPT_ZSTD_OUTPUT_BYTES });
  };
  const read = (request: TranscriptRequest = {}) => readTranscriptPage({ ...options, request, decompress,
    prepare: prefix => prefix.toString().startsWith('"header"\n') ? undefined : 'refused' });
  const latest = await read({ limit: 1 });
  assert.deepEqual(latest.items.map(i => i.text), ['body']);
  assert.deepEqual((await read({ cursor: latest.before })).items.map(i => i.text), ['header']);
  await writeFile(file, zstdCompressSync(Buffer.from('"foreign header"\n')));
  assert.equal((await read()).status, 'refused');
  await writeFile(file, 'bad archive');
  assert.equal((await read()).status, 'archived');
  assert.equal(decoded, 4);
  await truncate(file, TRANSCRIPT_ZSTD_INPUT_BYTES + 1);
  assert.equal((await read()).status, 'archived');
  assert.equal(decoded, 4);
});

test('prefixBytes lets prepare inspect a bounded first line up to TRANSCRIPT_LINE_BYTES', async t => {
  const { file, options } = await fixture(t);
  const longFirst = JSON.stringify('x'.repeat(80 * 1024)) + '\n"second"\n';
  await writeFile(file, longFirst);
  const seen: number[] = [];
  const res = await readTranscriptPage({
    ...options,
    prefixBytes: TRANSCRIPT_LINE_BYTES + 2,
    prepare(prefix) {
      seen.push(prefix.indexOf(10));
      return prefix.indexOf(10) >= 0 ? undefined : 'unsupported';
    },
    request: { limit: 2 },
  });
  assert.equal(res.status, 'ok');
  assert.ok(seen[0]! > 80 * 1024);
  assert.equal(res.items[1]?.text, 'second');
});
