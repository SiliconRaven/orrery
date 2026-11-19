// Masking orrery's reusable wait tickets in transcript text (src/adapters/shared/wait-ticket.ts).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { maskDrafts, maskTickets, TICKET_MASK } from '../src/adapters/shared/wait-ticket.ts';
import { QODER_WAIT, WORKBUDDY_WAIT, ZCODE_WAIT } from '../src/core/types.ts';
import { ticketFor, waitCommand } from '../src/mcp/wait-core.ts';

const SECRET = 'synthetic-bridge-secret';
const HEX = /[0-9a-f]{64}/;

test('every wait harness\'s ticket loses its secret part; the prefix and session id stay', () => {
  for (const [h, session] of [[ZCODE_WAIT, 'sess_synthetic.0001'], [QODER_WAIT, '0b6a4d5e-1f2a-4c3b-8d9e-0f1a2b3c4d5e'],
    [WORKBUDDY_WAIT, 'synthetic-session']] as const) {
    const ticket = ticketFor(h, SECRET, session);
    const command = waitCommand(h, ticket, 'http://127.0.0.1:4999');
    const masked = maskTickets(`run: ${command}\n${JSON.stringify({ command })}`);
    assert.ok(!HEX.test(masked), masked);
    assert.ok(masked.includes(`${ticket.slice(0, 3)}${session}.${TICKET_MASK} http://127.0.0.1:4999`), masked);
  }
});

test('other text, look-alikes inside longer tokens and short hex stay as they are', () => {
  const hex = 'a'.repeat(64);
  for (const text of ['plain text', `commit ${hex}`, `xz1.session.${hex}`, `z1.session.${'a'.repeat(63)}`, `z1.session.${hex}0`]) {
    assert.equal(maskTickets(text), text);
  }
  const drafts = maskDrafts([{ kind: 'thinking' }, { kind: 'tool_call', text: `z1.s.${hex}`, source: { toolName: `z1.s.${hex}` } }]);
  assert.deepEqual(drafts, [{ kind: 'thinking' }, { kind: 'tool_call', text: `z1.s.${TICKET_MASK}`, source: { toolName: `z1.s.${hex}` } }]);
});
