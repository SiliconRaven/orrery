import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheToolFingerprints, fingerprintTools } from '../src/mcp/tool-fingerprint.ts';
import { startTestHub } from './helpers.ts';

test('fingerprints include all transmitted definitions and normalize object and tool order', () => {
  const a = { name: 'alpha', description: 'first', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } };
  const b = { name: 'beta', description: 'second', inputSchema: { type: 'object', required: ['x', 'y'] } };
  const original = fingerprintTools([a, b]);
  assert.match(original, /^sha256:[0-9a-f]{64}$/);
  assert.equal(fingerprintTools([{ inputSchema: b.inputSchema, description: b.description, name: b.name },
    { inputSchema: { properties: { x: { type: 'string' } }, type: 'object' }, name: a.name, description: a.description }]), original);
  assert.notEqual(fingerprintTools([{ ...a, description: 'changed' }, b]), original);
  assert.notEqual(fingerprintTools([{ ...a, inputSchema: { type: 'object', properties: { x: { type: 'number' } } } }, b]), original);
  assert.notEqual(fingerprintTools([a, { ...b, inputSchema: { ...b.inputSchema, required: ['y', 'x'] } }]), original);
  assert.notEqual(fingerprintTools([a, { ...b, outputSchema: { type: 'string' } }]), original);
  assert.notEqual(fingerprintTools([a]), original);
});

test('fingerprints are lazy, shared per instance, and retried after failure', async () => {
  let calls = 0;
  const expected = { standard: 's', antigravity: 'a', zcode: 'z', qoder: 'q', workbuddy: 'w' };
  const get = cacheToolFingerprints(async () => {
    calls++;
    if (calls === 1) throw new Error('unavailable');
    return expected;
  });
  assert.equal(calls, 0);
  await assert.rejects(get(), /unavailable/);
  assert.deepEqual(await Promise.all([get(), get()]), [expected, expected]);
  assert.deepEqual(await get(), expected);
  assert.equal(calls, 2);
});

test('Hub reports the fingerprints of its actual MCP lists for each profile', async () => {
  const app = await startTestHub();
  try {
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    const report = await app.api('GET', '/api/tool-versions');
    const list = async (harness?: string, session?: string) => {
      const response = await fetch(`${app.url}/mcp`, { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          'x-orrery-bridge': secret, ...(harness ? { 'x-orrery-harness': harness } : {}),
          ...(session ? { 'x-orrery-session': session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(response.status, 200);
      const json = await response.json() as { result: { tools: { name: string }[] } };
      return json.result.tools;
    };
    for (const [profile, harness, session] of [['standard', undefined, undefined], ['antigravity', 'antigravity', undefined],
      ['zcode', 'zcode', undefined], ['qoder', 'qoder', undefined], ['workbuddy', 'workbuddy', 'fingerprint']] as const) {
      assert.equal(report.hub[profile], fingerprintTools(await list(harness, session)), profile);
    }
    assert.equal(report.hub.standard, fingerprintTools(await list('deepseek', 'mock-session')));
    assert.notEqual(report.hub.standard, report.hub.antigravity);
    assert.notEqual(report.hub.standard, report.hub.zcode);
    assert.notEqual(report.hub.standard, report.hub.workbuddy);
    assert.notEqual(report.hub.antigravity, report.hub.zcode);
    assert.notEqual(report.hub.zcode, report.hub.workbuddy, 'two wait harnesses have their own descriptions');
    assert.notEqual(report.hub.zcode, report.hub.qoder);
  } finally { await app.close(); }
});
