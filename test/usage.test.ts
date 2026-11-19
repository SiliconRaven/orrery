// Quota and token counts (docs/usage.md): the file readers of every harness on temporary fixtures, and the Hub's
// tracker and API with fake native adapters. Never reads the real ~/.codex, ~/.claude, ~/.kimi-code or ~/.dsh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createClaudeNativeAdapter } from '../src/adapters/claude/native.ts';
import { cliEnv } from '../src/adapters/claude/cli.ts';
import { askUsage, fromGetUsage } from '../src/adapters/claude/usage.ts';
import { createCodexUsage, fromAppServer, fromRolloutLimits, normalize as codexNormalize, windowLabel } from '../src/adapters/codex/usage.ts';
import { createDeepseekNativeAdapter } from '../src/adapters/deepseek/native.ts';
import { tokensOf } from '../src/adapters/deepseek/store.ts';
import { createKimiUsage, fromOauthUsage } from '../src/adapters/kimi/usage.ts';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { JsonlFold, lastMatch } from '../src/adapters/shared/jsonl.ts';
import { parseTotals, SESSION_INFO_TTL_MS, UsageTracker } from '../src/core/usage.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import type { Member, QuotaSnapshot, SessionInfo, TokenTotals } from '../src/core/types.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';

const tok = (input: number, cachedInput: number, cacheWrite: number, output: number, reasoning = 0): TokenTotals => ({ input, cachedInput, cacheWrite, output, reasoning });
const lines = (...xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n';

test('usage jsonl: lastMatch reads backwards past big lines and a torn last line; JsonlFold reads only what was appended', async () => {
  const dir = tempDir();
  const f = join(dir, 'a.jsonl');
  const big = 'x'.repeat(600_000);
  writeFileSync(f, lines({ k: 'hit', n: 1 }, { k: 'other', pad: big }, { k: 'hit', n: 2, pad: big }) + '{"k":"hit","n":3');
  assert.equal(await lastMatch(f, '"hit"', (e) => e.n), 2, 'the torn last line is skipped');
  assert.equal(await lastMatch(f, '"hit"', (e) => (e.n === 1 ? 'first' : undefined)), 'first');
  assert.equal(await lastMatch(f, 'nothing', () => 1), undefined);

  let steps = 0;
  const fold = new JsonlFold<{ sum: number }>(() => ({ sum: 0 }), (s, e) => { steps++; s.sum += e.n ?? 0; });
  const g = join(dir, 'b.jsonl');
  writeFileSync(g, lines({ n: 1 }, { n: 2 }) + '{"n":');
  assert.equal((await fold.read(g))!.sum, 3);
  appendFileSync(g, '4}\n' + lines({ n: 8 }));
  assert.equal((await fold.read(g))!.sum, 15, 'the line finished later counts once');
  assert.equal(steps, 4, 'old lines are not read again');
  assert.equal((await fold.read(g))!.sum, 15);
  truncateSync(g, 0);
  writeFileSync(g, lines({ n: 5 }));
  assert.equal((await fold.read(g))!.sum, 5, 'a file that shrank is read from the start');
  assert.equal(await fold.read(join(dir, 'missing.jsonl')), null);
  appendFileSync(g, lines({ n: 1 }, { n: 1 }));
  const both = await Promise.all([fold.read(g), fold.read(g)]);
  assert.deepEqual(both.map((x) => x!.sum), [7, 7], 'two reads at once fold the new lines once');
});

test('usage totals: parseTotals takes non-negative integers only (missing → 0)', () => {
  assert.deepEqual(parseTotals({ input: 1, output: 2 }), tok(1, 0, 0, 2));
  assert.equal(parseTotals({ input: -1 }), null);
  assert.equal(parseTotals({ input: 1.5 }), null);
  assert.equal(parseTotals({ input: '1' }), null);
  assert.equal(parseTotals([1]), null);
  assert.equal(parseTotals(null), null);
});

const T1 = '01a18969-e0ab-7530-819d-a00ae897addb';

/** A CODEX_HOME with one rollout per thread, shaped like the real ones (cached input inside input_tokens). */
function codexHome() {
  const home = join(tempDir(), 'codex-home');
  const day = join(home, 'sessions', '2026', '11', '03');
  mkdirSync(day, { recursive: true });
  const usage = (input: number, cached: number, output: number, reasoning: number) =>
    ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });
  const limits = (pct: number) => ({ limit_id: 'codex', primary: { used_percent: pct, window_minutes: 10080, resets_at: 1793802577 }, secondary: null, credits: { has_credits: false, unlimited: false, balance: '0' }, plan_type: 'plus' });
  const t1 = join(day, `rollout-2026-11-03T12-00-00-${T1}.jsonl`);
  writeFileSync(t1, lines(
    { timestamp: '2026-11-03T12:00:00.000Z', type: 'session_meta', payload: { id: T1 } },
    { timestamp: '2026-11-03T12:00:01.000Z', type: 'token_usage_record', payload: { turn_id: 'turn-a', turn_token_usage: usage(100, 60, 5, 1), thread_token_usage: usage(100, 60, 5, 1) } },
    { timestamp: '2026-11-03T12:00:02.000Z', type: 'token_usage_record', payload: { turn_id: 'turn-b', turn_token_usage: usage(50, 10, 3, 0), thread_token_usage: usage(150, 70, 8, 1) } },
    { timestamp: '2026-11-03T12:00:03.000Z', type: 'token_usage_record', payload: { turn_id: 'turn-b', turn_token_usage: usage(90, 30, 7, 2), thread_token_usage: usage(190, 90, 12, 3) } },
    { timestamp: '2026-11-03T12:00:03.500Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(190, 90, 12, 3) }, rate_limits: limits(41) } },
  ));
  utimesSync(t1, new Date('2026-11-03T12:00:04Z'), new Date('2026-11-03T12:00:04Z'));
  // A newer thread with no model call yet: the quota comes from the file before it.
  const t2 = join(day, 'rollout-2026-11-03T13-00-00-01a18969-e0ab-7530-819d-a00ae897ad00.jsonl');
  writeFileSync(t2, lines({ timestamp: '2026-11-03T13:00:00.000Z', type: 'session_meta', payload: {} }));
  return { home, t1, limits };
}

test('usage codex: rollout totals (cached input taken out), a turn by its id, the newest rate limits; app-server shape', async () => {
  const { home, t1, limits } = codexHome();
  const u = createCodexUsage(home);
  assert.deepEqual(await u.turnTokens(T1, 'turn-b'), tok(60, 30, 0, 7, 2), 'the last record of the turn');
  assert.deepEqual(await u.turnTokens(T1, 'turn-a'), tok(40, 60, 0, 5, 1));
  assert.equal(await u.turnTokens(T1, 'turn-x'), null);
  assert.deepEqual(await u.threadTokens(T1), tok(100, 90, 0, 12, 3));
  assert.equal(await u.threadTokens('01a18969-e0ab-7530-819d-a00ae897a000'), null, 'no rollout');
  const q = await u.quotaFromRollouts();
  assert.deepEqual(q, {
    plan: 'plus', windows: [{ id: 'primary', label: '每周', usedPercent: 41, resetsAt: new Date(1793802577_000).toISOString() }],
    observedAt: '2026-11-03T12:00:03.500Z', source: 'rollout',
  }, 'only the window the account has; seen when the line was written');
  appendFileSync(t1, lines({ timestamp: '2026-11-03T14:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: limits(55) } }));
  const later = new Date(Date.now() + 60_000); // newer than the other fixture files, whatever the wall clock says
  utimesSync(t1, later, later);
  assert.equal((await u.quotaFromRollouts())!.windows[0].usedPercent, 55, 'read again once the newest file changed');

  // account/rateLimits/read in the shape the desktop backend answered (2026-11-03; numbers made up).
  const real = {
    ordinaryUsageAllowed: true,
    rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1793802577 }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: '0' }, planType: 'plus' },
    rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1793802577 }, secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1793700000 }, credits: { hasCredits: true, unlimited: false, balance: '12.5' }, planType: 'plus' } },
  };
  const s = fromAppServer(real, '2026-11-03T15:00:00.000Z')!;
  assert.deepEqual(s.windows.map((w) => [w.id, w.label, w.usedPercent]), [['primary', '每周', 60], ['secondary', '5 小时', 12]], 'per limit id first');
  assert.equal(s.extra, 'credits 12.5');
  assert.equal(fromAppServer({ rateLimits: { primary: null, secondary: null } }, 'x'), null);
  assert.equal(fromRolloutLimits(null, 'x'), null);
  assert.deepEqual([windowLabel(300), windowLabel(10080), windowLabel(1440 * 30), windowLabel(90)], ['5 小时', '每周', '30 天', '90 分钟']);
  assert.deepEqual(codexNormalize({ input_tokens: 5, cached_input_tokens: 9, output_tokens: 1 }), tok(0, 5, 0, 1), 'cached never exceeds input');
});

test('usage kimi: oauth/usage as the 2.4.0 service answers it; session totals over all agents\' wire.jsonl, appended lines counted once', async () => {
  // The shape the running app returned (2026-11-03; numbers made up): no limit7d for that account.
  const data = { kind: 'ok', quota: { usages: { limit5h: { usedRatio: 0.4125, resetAt: '2026-11-03T14:20:00Z' }, monthTotal: { usedRatio: 0.2, resetAt: '2026-11-23T00:00:00Z' }, monthCode: { usedRatio: 0.1 } }, extraUsage: null } };
  const s = fromOauthUsage(data, '2026-11-03T13:00:00.000Z')!;
  assert.deepEqual(s.windows.map((w) => [w.id, w.label, Math.round(w.usedPercent * 100) / 100, w.resetsAt]), [
    ['limit5h', '5 小时', 41.25, '2026-11-03T14:20:00.000Z'],
    ['monthTotal', '本月（全部）', 20, '2026-11-23T00:00:00.000Z'],
    ['monthCode', '本月（Code）', 10, null],
  ]);
  assert.equal(s.source, 'oauth/usage');
  assert.throws(() => fromOauthUsage({ kind: 'error', message: 'not logged in' }, 'x'), /not logged in/);
  assert.equal(fromOauthUsage({ kind: 'ok', quota: { usages: {} } }, 'x'), null);

  const home = join(tempDir(), 'kimi-home');
  const sid = 'session_11111111-1111-4111-8111-111111111111';
  const agents = join(home, 'sessions', 'wd1', sid, 'agents');
  const rec = (inputOther: number, output: number, inputCacheRead: number) => ({ type: 'usage.record', agentId: 'main', usage: { inputOther, output, inputCacheRead, inputCacheCreation: 0 }, usageScope: 'turn' });
  mkdirSync(join(agents, 'main'), { recursive: true });
  mkdirSync(join(agents, 'agent-0'), { recursive: true });
  writeFileSync(join(agents, 'main', 'wire.jsonl'), lines(rec(10, 2, 100), { type: 'context.append_loop_event', event: { usage: { inputOther: 999 } } }, rec(5, 1, 50)));
  writeFileSync(join(agents, 'agent-0', 'wire.jsonl'), lines(rec(1, 1, 1)));
  const u = createKimiUsage(home);
  assert.deepEqual(await u.sessionTokens(sid), tok(16, 151, 0, 4));
  appendFileSync(join(agents, 'main', 'wire.jsonl'), lines(rec(100, 0, 0)));
  assert.deepEqual(await u.sessionTokens(sid), tok(116, 151, 0, 4));
  assert.equal(await u.sessionTokens('session_22222222-2222-4222-8222-222222222222'), null);
  // An agents folder whose wire.jsonl cannot be read proves nothing: unknown, not zero (review usage r1, P2-2).
  const sid3 = 'session_33333333-3333-4333-8333-333333333333';
  mkdirSync(join(home, 'sessions', 'wd1', sid3, 'agents', 'main'), { recursive: true });
  assert.equal(await u.sessionTokens(sid3), null);
});

test('usage claude: one count per message id across repeated lines and subagent transcripts; sessions of the native adapter', async () => {
  const claudeDir = join(tempDir(), 'claude');
  const id = 'aaaaaaaa-1111-4111-8111-111111111111';
  const folder = join(claudeDir, 'projects', 'C--work');
  mkdirSync(join(folder, id, 'subagents'), { recursive: true });
  const asst = (msgId: string | undefined, input: number, cacheCreate: number, cacheRead: number, output: number) =>
    ({ type: 'assistant', cwd: 'C:\\work', message: { id: msgId, model: 'claude-x', usage: { input_tokens: input, cache_creation_input_tokens: cacheCreate, cache_read_input_tokens: cacheRead, output_tokens: output } } });
  writeFileSync(join(folder, `${id}.jsonl`), lines(
    { type: 'user', cwd: 'C:\\work', message: { content: 'hi' } },
    asst('m1', 3, 10, 100, 5), asst('m1', 3, 10, 100, 5), asst('m1', 3, 10, 100, 7),   // one message, one line per block
    asst('m2', 1, 0, 200, 2),
  ));
  writeFileSync(join(folder, id, 'subagents', 'agent-x.jsonl'), lines(asst('m3', 4, 4, 4, 4)));
  const a = createClaudeNativeAdapter({ claudeDir });
  assert.deepEqual(await a.conversationTokens!(id), tok(8, 304, 14, 13), 'the last line of a message wins');
  assert.equal(await a.conversationTokens!('bbbbbbbb-1111-4111-8111-111111111111'), null);
  assert.equal(await a.conversationTokens!('../x'), null);
});

test('usage claude: get_usage answers as a snapshot; null windows skipped, percents clamped, a bad date is no date', () => {
  const at = '2026-11-06T10:00:00.000Z';
  const answer = (rate_limits: unknown, more = {}) => ({ subscription_type: 'max', rate_limits_available: true, rate_limits, behaviors: null, ...more });
  assert.deepEqual(fromGetUsage(answer({
    five_hour: { utilization: 56, resets_at: '2026-11-06T15:00:00+00:00' },
    seven_day: { utilization: 140, resets_at: 'soon' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: -3, resets_at: null },
    extra_usage: { utilization: 1 },
  }), at), {
    plan: 'max',
    windows: [
      { id: 'five_hour', label: '5 小时', usedPercent: 56, resetsAt: '2026-11-06T15:00:00.000Z' },
      { id: 'seven_day', label: '每周', usedPercent: 100, resetsAt: null },
      { id: 'seven_day_sonnet', label: '每周 Sonnet', usedPercent: 0, resetsAt: null },
    ],
    observedAt: at, source: 'get_usage',
  });
  assert.equal(fromGetUsage(answer({ seven_day_opus: { utilization: 1, resets_at: null } }, { subscription_type: 7 }), at)!.plan, undefined);
  assert.equal(fromGetUsage(answer({ seven_day: { utilization: 1 } }, { subscription_type: 'x'.repeat(60) }), at)!.plan!.length, 40);
  assert.equal(fromGetUsage(answer({ five_hour: { utilization: Number.NaN } }), at), null, 'no window');
  assert.equal(fromGetUsage(answer({}), at), null);
  assert.equal(fromGetUsage(answer({ five_hour: { utilization: 1 } }, { rate_limits_available: false }), at), null);
  assert.equal(fromGetUsage(answer(null, { rate_limits_available: false }), at), null);
  assert.equal(fromGetUsage(null, at), null);
  assert.throws(() => fromGetUsage(answer(null), at), /gave no rate limits/, 'available but none given: say so, not a silent null');
});

const USAGE_OK = {
  subscription_type: 'pro', rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 56, resets_at: '2026-11-06T15:00:00Z' }, seven_day: { utilization: 11, resets_at: '2026-11-10T15:00:00Z' }, seven_day_opus: null },
};

/**
 * A fake CLI run with this Node through the real spawn: records each start in runs.log, then `body` (JS). In `body`,
 * onRequest(fn) gets the first stdin line as JSON and answer(response) writes it back as a control_response.
 * It exits when stdin ends, unless `body` keeps it alive.
 */
function fakeCli(body: string) {
  const dir = tempDir();
  const script = join(dir, 'fake-claude.mjs');
  const log = join(dir, 'runs.log');
  writeFileSync(script, `
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({
      pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), apiKey: process.env.ANTHROPIC_API_KEY ?? null,
      configDir: process.env.CLAUDE_CONFIG_DIR ?? null, traffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null,
    }) + '\\n');
    const answer = (response) => process.stdout.write(JSON.stringify({ type: 'control_response', response }) + '\\n');
    const onRequest = (fn) => {
      let buf = '';
      process.stdin.setEncoding('utf8').on('data', (d) => {
        buf += d;
        if (buf.includes('\\n')) { fn(JSON.parse(buf.split('\\n')[0])); buf = ''; }
      });
    };
    process.stdin.on('end', () => process.exit(0));
    ${body}
  `);
  return {
    command: { command: process.execPath, args: [script] },
    runs: (): any[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
  };
}

const answersUsage = `onRequest((r) => {
  if (r.type !== 'control_request' || r.request.subtype !== 'get_usage' || r.request.skip_behaviors !== true) process.exit(9);
  console.log('not json');
  console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
  answer({ subtype: 'success', request_id: 'someone-else', response: {} });
  answer({ subtype: 'success', request_id: r.request_id, response: ${JSON.stringify(USAGE_OK)} });
});`;

test('usage claude quota: a refresh asks the CLI over stdin and stdout, in the worker\'s isolation and with no API key', { timeout: 20_000 }, async () => {
  const fake = fakeCli(answersUsage);
  const claudeDir = join(tempDir(), 'claude');
  process.env.ANTHROPIC_API_KEY = 'not-a-real-key';
  try {
    const snap = await createClaudeNativeAdapter({ claudeDir, command: fake.command }).quota!({ refresh: true });
    assert.equal(snap!.source, 'get_usage');
    assert.equal(snap!.plan, 'pro');
    assert.deepEqual(snap!.windows.map((w) => [w.id, w.usedPercent]), [['five_hour', 56], ['seven_day', 11]]);
    assert.ok(!Number.isNaN(Date.parse(snap!.observedAt)));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
  const [run] = fake.runs();
  assert.equal(run.apiKey, null, 'the allowlist keeps the API key out');
  assert.equal(run.configDir, claudeDir);
  assert.equal(run.traffic, null, 'get_usage runs without the nonessential-traffic switch, which keeps the CLI from fetching the limits');
  assert.equal(cliEnv(process.env, claudeDir).CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1', 'the plain CLI environment keeps it');
  assert.equal(resolve(run.cwd).toLowerCase(), resolve(tmpdir()).toLowerCase());
  const after = (flag: string) => run.argv[run.argv.indexOf(flag) + 1];
  assert.equal(after('--tools'), '');
  assert.equal(after('--setting-sources'), '');
  assert.equal(after('--settings'), '{"disableAllHooks":true}');
  assert.equal(after('--mcp-config'), '{"mcpServers":{}}');
  assert.equal(after('--permission-mode'), 'dontAsk');
  for (const flag of ['-p', '--strict-mcp-config', '--no-session-persistence']) assert.ok(run.argv.includes(flag), flag);
});

test('usage claude quota: the timed poll never starts a process; a refresh does, at most once per interval', { timeout: 20_000 }, async () => {
  const fake = fakeCli(answersUsage);
  const a = createClaudeNativeAdapter({ claudeDir: tempDir(), command: fake.command });
  assert.equal(await a.quota!({ refresh: false }), null, 'nothing known yet');
  assert.equal(fake.runs().length, 0);
  const [one, two] = await Promise.all([a.quota!({ refresh: true }), a.quota!({ refresh: true })]);
  assert.equal(fake.runs().length, 1, 'concurrent refreshes share one process');
  assert.deepEqual([one, two].filter(Boolean).length, 1);
  const snap = one ?? two;
  assert.equal(await a.quota!({ refresh: true }), snap, 'inside the interval: the last answer');
  assert.equal(await a.quota!({ refresh: false }), snap);
  assert.equal(fake.runs().length, 1);

  const b = createClaudeNativeAdapter({ claudeDir: tempDir(), command: fake.command, quotaRefreshMinMs: 0 });
  await b.quota!({ refresh: true });
  await b.quota!({ refresh: true });
  assert.equal(fake.runs().length, 3, 'past the interval it asks again');
});

test('usage claude quota: an error answer, an early exit and a CLI that cannot start reject, without the CLI\'s output', { timeout: 20_000 }, async () => {
  const quota = (body: string) => createClaudeNativeAdapter({ claudeDir: tempDir(), command: fakeCli(body).command }).quota!({ refresh: true });
  await assert.rejects(quota(`onRequest((r) => answer({ subtype: 'error', request_id: r.request_id, error: 'secret detail' }));`),
    (e: Error) => /answered with an error/.test(e.message) && !e.message.includes('secret'));
  await assert.rejects(quota(`onRequest((r) => answer({ subtype: 'success', request_id: r.request_id, response: { rate_limits_available: true, rate_limits: null } }));`),
    /gave no rate limits/);
  await assert.rejects(quota(`console.log('secret detail'); process.exit(3);`),
    (e: Error) => /code 3 before answering/.test(e.message) && !e.message.includes('secret'));
  const missing = { command: join(tempDir(), 'no-such-claude.exe'), args: [] };
  await assert.rejects(createClaudeNativeAdapter({ claudeDir: tempDir(), command: missing }).quota!({ refresh: true }), /cannot start claude/);
});

test('usage claude quota: a hung CLI is stopped at the timeout; endless output is cut off; a lingering one keeps its answer', { timeout: 30_000 }, async () => {
  const dead = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  const hung = fakeCli(`setInterval(() => {}, 1000);`);
  await assert.rejects(createClaudeNativeAdapter({ claudeDir: tempDir(), command: hung.command, quotaTimeoutMs: 500 }).quota!({ refresh: true }), /timed out after 500 ms/);
  assert.ok(dead(hung.runs()[0].pid), 'the hung process is gone');

  const noisy = fakeCli(`const line = 'x'.repeat(64 * 1024); const more = () => process.stdout.write(line, more); more();`);
  await assert.rejects(createClaudeNativeAdapter({ claudeDir: tempDir(), command: noisy.command }).quota!({ refresh: true }), /too much output/);
  assert.ok(dead(noisy.runs()[0].pid), 'the noisy process is gone');

  const lingering = fakeCli(`
    process.stdin.removeAllListeners('end');
    process.stdin.on('end', () => {});
    setInterval(() => {}, 1000);
    ${answersUsage}
  `);
  const snap = await createClaudeNativeAdapter({ claudeDir: tempDir(), command: lingering.command, quotaTimeoutMs: 3000 }).quota!({ refresh: true });
  assert.equal(snap!.source, 'get_usage');
  assert.ok(dead(lingering.runs()[0].pid), 'stopped after answering');
});

test('usage claude quota: unconfirmed tree cleanup rejects even after a valid answer',
  { timeout: 15_000, skip: process.platform !== 'win32' && 'Windows taskkill only' }, async () => {
    const dir = tempDir();
    const answered = join(dir, 'answered');
    const lingering = fakeCli(`
      process.stdin.removeAllListeners('end');
      process.stdin.on('end', () => {});
      setInterval(() => {}, 1000);
      onRequest((r) => {
        answer({ subtype: 'success', request_id: r.request_id, response: ${JSON.stringify(USAGE_OK)} });
        appendFileSync(${JSON.stringify(answered)}, 'sent');
      });
    `);
    try {
      await assert.rejects(
        askUsage(lingering.command, { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }, 2000, {
          taskkill: { command: join(dir, 'missing-taskkill.exe'), args: [] },
        }),
        /timed out after 2000 ms; taskkill could not start; tree cleanup unconfirmed$/,
      );
      assert.equal(existsSync(answered), true, 'the helper sent a valid answer before timeout');
      const pid = lingering.runs()[0].pid as number;
      await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'lingering helper to exit', 2000);
    } finally {
      for (const run of lingering.runs()) {
        try { process.kill(run.pid, 0); process.kill(run.pid); } catch { /* already gone */ }
      }
    }
  });

test('usage deepseek: the projection cache\'s tokenUsage totals', async () => {
  const dshHome = join(tempDir(), 'dsh');
  const dir = join(dshHome, 'storages', 'session_projcache', 'sessions');
  mkdirSync(dir, { recursive: true });
  const record = { record: { identity: { cwd: 'C:\\w', createdAt: 1 }, rows: { tokenUsage: { ver: 2, seq: 1, val: { totals: { uncachedInputTokens: 300, outputTokens: 20, cacheReadTokens: 5000, cacheWriteTokens: 7 } } } } } };
  writeFileSync(join(dir, 'session-a.json'), JSON.stringify(record));
  writeFileSync(join(dir, 'session-b.json'), JSON.stringify({ record: { identity: { cwd: 'C:\\w', createdAt: 1 }, rows: {} } }));
  assert.deepEqual(tokensOf(record), tok(300, 5000, 7, 20));
  const a = createDeepseekNativeAdapter({ dshHome });
  assert.deepEqual(await a.conversationTokens!('session-a'), tok(300, 5000, 7, 20));
  assert.equal(await a.conversationTokens!('session-b'), null);
  assert.equal(await a.conversationTokens!('../session-a'), null);
  assert.equal(a.quota, undefined, 'pay-as-you-go: no time windows');
});

const SNAP = (pct: number, observedAt: string): QuotaSnapshot => ({ windows: [{ id: 'w', label: '每周', usedPercent: pct, resetsAt: '2026-11-10T00:00:00.000Z' }], observedAt, source: 'fake' });

/** A Hub with a native 'quota' harness (quota + conversation totals + turn usage) and a 'plain' one without any. */
async function usageHub(dir = tempDir()) {
  const calls: boolean[] = [];
  let pct = 10;
  let turnUsage: TokenTotals | null = tok(100, 20, 3, 7, 1);
  const quotaAdapter = createMockNativeAdapter({
    harness: 'quota', kind: 'queue', sessions: [{ id: 'q1', title: 'q1', model: null, cwd: dir, updatedAt: null }],
    onDeliver: async (_s, _t, ctx) => {
      // Reported twice: the second count replaces the first (the same batch).
      if (turnUsage) { ctx.usage?.(tok(1, 1, 1, 1)); ctx.usage?.(turnUsage); }
      return 'completed';
    },
  });
  quotaAdapter.quota = async ({ refresh }) => {
    calls.push(refresh);
    return SNAP(pct, refresh ? '2026-11-03T12:00:00.000Z' : '2026-11-03T11:00:00.000Z');
  };
  quotaAdapter.conversationTokens = async (id) => (id === 'q1' ? tok(1000, 2000, 0, 50) : null);
  const plain = createMockNativeAdapter({ harness: 'plain', kind: 'queue', sessions: [{ id: 'p1', title: 'p1', model: null, cwd: dir, updatedAt: null }] });
  const app = await startTestHub({ dir, nativeAdapters: { quota: quotaAdapter, plain }, limits: { quotaPollMs: 60_000 } });
  const { cluster, members } = await app.api('POST', '/api/clusters', {
    name: 'u', members: [{ harness: 'quota', mode: 'native', sessionId: 'q1', name: 'Q' }, { harness: 'plain', mode: 'native', sessionId: 'p1', name: 'P' }],
  });
  return { app, cluster, members, calls, setPct: (n: number) => { pct = n; }, setTurnUsage: (t: TokenTotals | null) => { turnUsage = t; } };
}

test('usage hub: per-member tokens via orrery and whole conversation, cluster totals, quota per harness; refresh asks the source', async () => {
  const h = await usageHub();
  const [q, p] = h.members;
  try {
    const sent = await h.app.api('POST', `/api/clusters/${h.cluster.id}/messages`, { body: '@all hello' });
    await waitFor(() => h.app.settled(h.cluster.id), 'delivered');
    await waitFor(() => h.calls.length > 0, 'the poll at start-up');
    let r = await h.app.api('GET', `/api/usage?cluster=${h.cluster.id}`);
    // `session` (the conversation's title and model, docs/cluster-members.md) is checked on its own below.
    const row = (id: string) => { const { session: _, ...rest } = r.members.find((m: any) => m.memberId === id); return rest; };
    const sessionOf = (id: string) => r.members.find((m: any) => m.memberId === id).session;
    assert.deepEqual([sessionOf(q.id).title, sessionOf(p.id).title], ['q1', 'p1'], 'read when added');
    assert.deepEqual(row(q.id), { memberId: q.id, harness: 'quota', viaOrrery: { totals: tok(100, 20, 3, 7, 1), turns: 1 }, conversationSupported: true, conversation: tok(1000, 2000, 0, 50), latestTurnTokens: 127, alert: null });
    assert.deepEqual(row(p.id), { memberId: p.id, harness: 'plain', viaOrrery: null, conversationSupported: false, conversation: null, latestTurnTokens: null, alert: null });
    assert.deepEqual(r.cluster, { viaOrrery: tok(100, 20, 3, 7, 1), conversation: tok(1000, 2000, 0, 50) });
    assert.deepEqual(r.quotas, [
      { harness: 'quota', supported: true, snapshot: SNAP(10, '2026-11-03T11:00:00.000Z') },
      { harness: 'plain', supported: false, snapshot: null },
    ]);
    assert.deepEqual(h.calls, [false], 'only cheap reads unless asked');
    assert.ok(h.app.events.some((e) => e.kind === 'usage' && (e.payload as any).turn?.batchId && e.memberId === q.id), 'a usage event per recorded turn');
    assert.ok(h.app.events.some((e) => e.kind === 'usage' && (e.payload as any).quota?.harness === 'quota'), 'a usage event when the quota changed');
    assert.ok(sent.id);

    h.setPct(30);
    const refreshed = await h.app.api('POST', '/api/usage/refresh', {});
    assert.deepEqual(refreshed, { results: { quota: { ok: true } } });
    assert.deepEqual(h.calls, [false, true]);
    r = await h.app.api('GET', `/api/usage?cluster=${h.cluster.id}`);
    assert.deepEqual(r.quotas[0].snapshot, SNAP(30, '2026-11-03T12:00:00.000Z'));
    // A cheap read that is older than what the refresh brought never replaces it.
    h.setPct(5);
    await (h.app.hub as any).usage.poll(false);
    assert.equal((await h.app.api('GET', `/api/usage?cluster=${h.cluster.id}`)).quotas[0].snapshot.windows[0].usedPercent, 30);

    // Same protections as every other write: JSON only.
    const res = await fetch(`${h.app.url}/api/usage/refresh`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(res.status, 415);
    await assert.rejects(h.app.api('GET', '/api/usage?cluster=nope'), /unknown cluster/);
    const all = await h.app.api('GET', '/api/usage');
    assert.equal(all.clusterId, null);
    assert.equal(all.members.length, 2);
  } finally {
    await h.app.close();
  }
});

test('usage hub: the last quota and the recorded turns survive a restart; a failing source keeps the last snapshot and says why', async () => {
  const dir = tempDir();
  const h = await usageHub(dir);
  try {
    await h.app.api('POST', `/api/clusters/${h.cluster.id}/messages`, { body: '@Q one' });
    await waitFor(() => h.app.settled(h.cluster.id), 'delivered');
    await waitFor(() => h.calls.length > 0, 'polled');
  } finally {
    await h.app.close();
  }

  const again = await startTestHub({
    dir, limits: { quotaPollMs: 0 },
    nativeAdapters: {
      quota: Object.assign(createMockNativeAdapter({ harness: 'quota', kind: 'queue' }), { quota: async () => { throw new Error('source down'); } }),
      plain: createMockNativeAdapter({ harness: 'plain', kind: 'queue' }),
    },
  });
  try {
    let r = await again.api('GET', `/api/usage?cluster=${h.cluster.id}`);
    assert.deepEqual(r.quotas[0].snapshot, SNAP(10, '2026-11-03T11:00:00.000Z'), 'from the database');
    assert.deepEqual(r.members[0].viaOrrery, { totals: tok(100, 20, 3, 7, 1), turns: 1 });
    assert.deepEqual(await again.api('POST', '/api/usage/refresh', {}), { results: { quota: { ok: false, error: 'source down' } } });
    r = await again.api('GET', `/api/usage?cluster=${h.cluster.id}`);
    assert.deepEqual([r.quotas[0].snapshot.windows[0].usedPercent, r.quotas[0].error], [10, 'source down']);
  } finally {
    await again.close();
  }
});

test('usage report: a native conversation\'s title and model, re-read only from adapters that read local files, at most every few minutes', async () => {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  const info: SessionInfo = { id: 's1', title: '修复结账页', model: 'm-1', cwd: 'D:/work/shop', updatedAt: null };
  let reads = 0;
  let fail = false;
  const local = createMockNativeAdapter({ harness: 'local', localSessions: true, sessions: [info] });
  local.attachSession = async () => { reads++; if (fail) throw new Error('gone'); return { ...info }; };
  const remote = createMockNativeAdapter({ harness: 'remote', sessions: [{ ...info, id: 'r1' }] });
  remote.attachSession = async () => { throw new Error('must not be called by the report'); };
  const tracker = new UsageTracker({ store, pollMs: 0, harnessesInUse: () => [], emit: () => {}, adapters: { local, remote } });
  const member = (id: string, harness: string, sessionId: string): Member => ({ id, clusterId: 'c', name: id, avatar: null, harness,
    model: null, effort: null, workerSessionId: sessionId, cwd: 'D:/work/shop', origin: 'attached', status: 'idle', removedAt: null, hiddenAt: null });
  const members = [member('a', 'local', 's1'), member('b', 'local', 's1'), member('r', 'remote', 'r1')];
  try {
    let rows = (await tracker.report('c', members)).members;
    assert.equal(reads, 1, 'one read for two memberships of one conversation');
    assert.deepEqual(rows.map((r) => r.session?.title ?? null), ['修复结账页', '修复结账页', null], 'remote: nothing read');
    assert.equal(rows[0].session!.model, 'm-1');
    await tracker.report('c', members);
    assert.equal(reads, 1, 'fresh: not read again');

    tracker.sessionSeen('remote', { id: 'r1', title: '评审', model: null });   // e.g. the add dialog listed it
    info.title = '改名后的标题';
    const old = new Date(Date.now() - SESSION_INFO_TTL_MS - 1000).toISOString();
    tracker.sessionSeen('local', { id: 's1', title: '旧标题', model: 'm-1' }, old);
    rows = (await tracker.report('c', members)).members;
    assert.equal(reads, 2, 'older than the TTL: read again');
    assert.equal(rows[0].session!.title, '改名后的标题');
    assert.equal(rows[2].session!.title, '评审', 'what the Hub was given is kept for adapters it never asks');

    fail = true;
    tracker.sessionSeen('local', { id: 's1', title: '旧标题', model: 'm-1' }, old);
    rows = (await tracker.report('c', members)).members;
    assert.deepEqual(rows[0].session, { sessionId: 's1', title: '旧标题', model: 'm-1', observedAt: old }, 'a failed read keeps the last info with its own time');
  } finally { await tracker.close(); store.close(); }
});

test('usage report after a rebind: the session info is the new conversation\'s and says which conversation it was read for', async () => {
  const dir = tempDir();
  const sessions = [{ id: 'sA', title: 'Old conversation', model: 'model-a', cwd: join(dir, 'alpha'), updatedAt: null },
    { id: 'sB', title: 'New conversation', model: 'model-b', cwd: join(dir, 'beta'), updatedAt: null }];
  const local = createMockNativeAdapter({ harness: 'local', localSessions: true, sessions });
  const app = await startTestHub({ dir, nativeAdapters: { local } });
  try {
    const { cluster, members: [m] } = await app.api('POST', '/api/clusters', { name: 'rb', members: [{ harness: 'local', mode: 'native', sessionId: 'sA', name: 'mover' }] });
    const session = async () => { const { observedAt: _, ...s } = (await app.api('GET', `/api/usage?cluster=${cluster.id}`)).members[0].session; return s; };
    assert.deepEqual(await session(), { sessionId: 'sA', title: 'Old conversation', model: 'model-a' });
    await app.api('POST', `/api/members/${m.id}/session`, { harness: 'local', sessionId: 'sB', confirmStopped: true });
    assert.deepEqual(await session(), { sessionId: 'sB', title: 'New conversation', model: 'model-b' });
  } finally { await app.close(); }
});
