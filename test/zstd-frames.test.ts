// The appended-zstd-frame transcript reader (src/adapters/shared/zstd-frames.ts) with synthetic records. Frames are
// compressed at run time; no binary fixture is committed.
import { strict as assert } from 'node:assert';
import { appendFile, link, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { constants, zstdCompressSync } from 'node:zlib';
import type { TranscriptDraft } from '../src/adapters/shared/transcript.ts';
import { FRAMED_INPUT_BYTES, FRAMED_PAGE_FRAMES, readFramedTranscriptPage } from '../src/adapters/shared/zstd-frames.ts';
import type { TranscriptRequest } from '../src/core/native-transcript.ts';
import { junction } from './extensions-fixture.ts';

/** One appended frame of JSONL records, with a content checksum as the observed writer uses. */
const frame = (...records: unknown[]) => zstdCompressSync(Buffer.from(records.map((r) => JSON.stringify(r) + '\n').join('')),
  { params: { [constants.ZSTD_c_checksumFlag]: 1 } });

/** A hand-built frame of `blocks` RLE blocks of 128 KiB each: tiny input, `blocks` * 128 KiB of output. */
function rleBomb(blocks: number): Buffer {
  const out = Buffer.alloc(6 + blocks * 4);
  out.set([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x38]);   // magic, no checksum or size, 128 KiB window
  for (let k = 0; k < blocks; k++) {
    out.writeUIntLE((128 * 1024) << 3 | 1 << 1 | (k === blocks - 1 ? 1 : 0), 6 + k * 4, 3);
    out[6 + k * 4 + 3] = 0x41;
  }
  return out;
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'sessions');
  await mkdir(root);
  const file = join(root, 'literal-session.jsonl.zstd');
  const parse = (value: unknown): TranscriptDraft[] | undefined => {
    if (typeof value === 'string') return value === 'header' ? [] : [{ kind: 'user', text: value }];
    if (Array.isArray(value)) return value.map((text) => ({ kind: 'assistant', text: String(text) }));
    return undefined;
  };
  const options = { root, file, sessionKey: 'literal-session-key', parse, unknownText: 'Unrecognized record.',
    prepare: (prefix: Buffer) => prefix.toString().startsWith('"header"\n') ? undefined : 'refused' as const };
  const page = (request: TranscriptRequest = {}) => readFramedTranscriptPage({ ...options, request });
  return { dir, root, file, options, page, texts: async (request: TranscriptRequest = {}) => (await page(request)).items.map((i) => i.text) };
}

test('pages backward and forward across frames and multi-item records; appended frames keep cursors valid', async (t) => {
  const { file, page, texts } = await fixture(t);
  await writeFile(file, Buffer.concat([frame('header', 'old'), frame(['a', 'b', 'c']), frame('current')]));
  const newest = await page({ limit: 2 });
  assert.equal(newest.status, 'ok');
  assert.deepEqual(newest.items.map((i) => i.text), ['c', 'current']);
  assert.equal(newest.hasMore, true);
  const previous = await page({ limit: 2, cursor: newest.before });
  assert.deepEqual(previous.items.map((i) => i.text), ['a', 'b']);
  assert.deepEqual(await texts({ limit: 2, cursor: previous.after, direction: 'after' }), ['c', 'current']);
  const oldest = await page({ limit: 2, cursor: previous.before });
  assert.deepEqual(oldest.items.map((i) => i.text), ['old']);
  assert.equal(oldest.before, undefined);
  assert.equal(oldest.hasMore, false);

  await appendFile(file, Buffer.concat([frame('new 1'), frame(['new 2', 'new 3'])]));
  const forward = await page({ limit: 2, cursor: newest.after, direction: 'after' });
  assert.deepEqual(forward.items.map((i) => i.text), ['new 1', 'new 2']);
  assert.equal(forward.hasMore, true);
  const rest = await page({ cursor: forward.after, direction: 'after' });
  assert.deepEqual(rest.items.map((i) => i.text), ['new 3']);
  assert.equal(rest.hasMore, false);
  assert.deepEqual(await texts({ cursor: rest.after, direction: 'after' }), []);
  assert.deepEqual(await texts({ limit: 3, cursor: newest.before }), ['old', 'a', 'b']);
});

test('a partly written last frame waits; a corrupt frame is one unknown item; an empty log has a cursor', async (t) => {
  const { file, page, texts } = await fixture(t);
  await writeFile(file, '');
  const empty = await page();
  assert.equal(empty.status, 'ok');
  assert.deepEqual(empty.items, []);
  assert.ok(empty.after);
  const head = frame('header', 'first');
  const next = frame('second');
  for (const cut of [2, 5, next.length - 2]) {   // inside the magic, inside the header, without the checksum
    await writeFile(file, Buffer.concat([head, next.subarray(0, cut)]));
    assert.deepEqual(await texts(), ['first']);
  }
  const waiting = await page({ cursor: empty.after, direction: 'after' });
  assert.deepEqual(waiting.items.map((i) => i.text), ['first']);
  await appendFile(file, next.subarray(next.length - 2));
  assert.deepEqual(await texts({ cursor: waiting.after, direction: 'after' }), ['second']);

  const corrupt = Buffer.from(frame('damaged'));
  corrupt[corrupt.length - 1]! ^= 0xff;            // checksum mismatch
  await appendFile(file, Buffer.concat([corrupt, frame('third')]));
  const after = await page();
  assert.deepEqual(after.items.map((i) => i.kind), ['user', 'user', 'unknown', 'user']);
  assert.equal(after.unknownCount, 1);
  assert.equal(after.items[2]!.text, 'Unrecognized record.');
  await writeFile(file, Buffer.concat([head, Buffer.from('not a zstd frame')]));
  assert.equal((await page()).status, 'unsupported');
});

test('decompression is capped: a bomb frame is not inflated, a large file is not read', async (t) => {
  const { file, page } = await fixture(t);
  const bomb = rleBomb(512 * 1024);                 // 2 MiB that would inflate to 64 GiB
  await writeFile(file, Buffer.concat([frame('header', 'before'), bomb, frame('after')]));
  const started = performance.now();
  const read = await page();
  assert.ok(performance.now() - started < 5000, 'the output limit stops inflation early');
  assert.equal(read.status, 'ok');
  assert.deepEqual(read.items.map((i) => i.kind), ['user', 'unknown', 'user']);
  assert.equal(read.items[1]!.truncated, true);
  await truncate(file, FRAMED_INPUT_BYTES + 1);
  assert.equal((await page()).status, 'archived');
});

test('a page inflates a bounded number of frames and continues with a cursor', async (t) => {
  const { file, page } = await fixture(t);
  const quiet = frame('header');
  await writeFile(file, Buffer.concat([frame('header', 'oldest'), ...Array(FRAMED_PAGE_FRAMES + 10).fill(quiet)]));
  const first = await page();
  assert.deepEqual(first.items, []);
  assert.equal(first.hasMore, true);
  assert.deepEqual((await page({ cursor: first.before })).items.map((i) => i.text), ['oldest']);
});

test('a page inflates at most its output budget, the header probe included, and pages on from the frame it stopped at', async (t) => {
  const { file, page } = await fixture(t);
  // Three frames that each inflate to about 3 MiB: 30 records of 100 KiB.
  const big = (name: string, header = false) => frame(...(header ? ['header'] : []),
    ...Array.from({ length: 30 }, (_, r) => `${name}:${r}:${'x'.repeat(100 * 1024)}`));
  const name = (text?: string) => text?.split(':', 1)[0];
  await writeFile(file, '');
  const start = (await page()).after!;
  await appendFile(file, Buffer.concat([big('f0', true), big('f1'), big('f2')]));

  // The probe inflates f0 (3 MiB); f2 then fits (6 MiB); f1 would pass 8 MiB, so the page stops before it.
  const newest = await page();
  assert.deepEqual([...new Set(newest.items.map((i) => name(i.text)))], ['f2']);
  assert.equal(newest.items.length, 30);
  assert.equal(newest.hasMore, true);
  const older = await page({ cursor: newest.before });
  assert.deepEqual([...new Set(older.items.map((i) => name(i.text)))], ['f0', 'f1'], 'f0 reuses the probe');
  assert.equal(older.items.length, 60);
  assert.equal(older.hasMore, false);
  assert.equal(older.before, undefined);

  const forward = await page({ cursor: start, direction: 'after' });
  assert.deepEqual([...new Set(forward.items.map((i) => name(i.text)))], ['f0', 'f1']);
  assert.equal(forward.hasMore, true);
  const rest = await page({ cursor: forward.after, direction: 'after' });
  assert.deepEqual([...new Set(rest.items.map((i) => name(i.text)))], ['f2']);
  assert.equal(rest.hasMore, false);
  assert.deepEqual(rest.items.map((i) => i.id), newest.items.map((i) => i.id));
  assert.deepEqual([...forward.items, ...rest.items].map((i) => i.id), [...older.items, ...newest.items].map((i) => i.id));
});

test('tampered and cross-session cursors, rewrites and replacement reset; a read writes nothing', async (t) => {
  const { root, file, options, page } = await fixture(t);
  await writeFile(file, frame('header', 'original'));
  const filesBefore = await readdir(root);
  const bytes = await readFile(file);
  const { mtimeMs } = await stat(file);
  const start = (await page()).after!;
  assert.deepEqual(await readdir(root), filesBefore);
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await stat(file)).mtimeMs, mtimeMs);
  const poll = (cursor: string) => page({ direction: 'after', cursor });
  assert.equal((await poll(`x${start.slice(1)}`)).status, 'reset');
  assert.equal((await readFramedTranscriptPage({ ...options, sessionKey: 'other', request: { cursor: start } })).status, 'reset');
  await writeFile(file, frame('header', 'rewritten'));
  assert.equal((await poll(start)).status, 'reset');
  const changed = (await page()).after!;
  await truncate(file, 4);
  assert.equal((await poll(changed)).status, 'reset');
  await writeFile(file, frame('header', 'again'));
  const again = (await page()).after!;
  await rename(file, `${file}.old`);
  await writeFile(file, frame('header', 'again'));
  assert.equal((await poll(again)).status, 'reset');
  await writeFile(file, frame('foreign header'));
  assert.equal((await page()).status, 'refused');
});

test('containment rejects outside paths, hard links and junctions', async (t) => {
  const { dir, root, file, options, page } = await fixture(t);
  assert.equal((await page()).status, 'missing');
  const outsideDir = join(dir, 'outside');
  const outsideFile = join(outsideDir, 'other.jsonl.zstd');
  await mkdir(outsideDir);
  await writeFile(outsideFile, frame('header', 'foreign record'));
  assert.equal((await readFramedTranscriptPage({ ...options, file: outsideFile, request: {} })).status, 'refused');
  await link(outsideFile, file);
  assert.equal((await page()).status, 'refused');
  const aliased = join(root, 'aliased');
  if (!junction(outsideDir, aliased)) return t.skip('the OS refused to create a junction');
  assert.equal((await readFramedTranscriptPage({ ...options, file: join(aliased, 'other.jsonl.zstd'), request: {} })).status, 'refused');
});
