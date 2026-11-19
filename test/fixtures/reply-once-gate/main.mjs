// A test fixture, not product code: a referee gate plugin (messages.gate). A round starts when the lead (its member
// name is read from lead.json next to this file) speaks, or when the `kickoff` command names every visible member
// (host.members.list) in one plugin message. In a round every other member may reply once.
//
// A reply counts only when the Hub reports it stored: the plugin opts in to message.check.result at initialize and
// keeps each allowed check by its checkId until the result comes. A reply another plugin refused, or one the Hub
// rejected after the check, does not use the member's turn, and a second reply while the first is undecided is
// refused. A result can also never come (an allow that reached the Hub after its 1.5 s timeout, or a result dropped
// while this plugin was not reading), so an undecided mark expires after `undecidedMs` (default 5 s): that reply is
// then not counted, and the member may reply again. Node built-ins only.
//
// lead.json: {"lead": "<member name>", "undecidedMs"?: number, "delayFirstReplyMs"?: number}. The last one is a test
// knob: answer the first member reply that late (to make the Hub time out).
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const { lead, undecidedMs = 5000, delayFirstReplyMs = 0 } = JSON.parse(readFileSync(new URL('./lead.json', import.meta.url), 'utf8'));
let delayedOnce = false;
const rounds = new Map();    // clusterId -> { replied: Set<memberId> } since the round started
const allowed = new Map();   // checkId -> { clusterId, senderId, lead, round }: allowed, outcome not known yet
const stored = new Map();    // clusterId -> Map<memberId, stored replies>, all rounds
const calls = new Map();     // this plugin's host requests waiting for an answer
let serial = 0;
let writeSettings = null;    // initialize, then writeSettings.changed
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

function host(method, params) {
  const id = `referee-${++serial}`;
  send({ id, method, params });
  return new Promise((resolve, reject) => calls.set(id, { resolve, reject }));
}

function check({ checkId, clusterId, sender }) {
  if (sender.name === lead) {
    allowed.set(checkId, { clusterId, senderId: sender.id, lead: true });
    return { allow: true };
  }
  const round = rounds.get(clusterId);
  if (!round) return { allow: false, reason: `${lead} 还没有发言，请等主持人先说。` };
  if (round.replied.has(sender.id)) return { allow: false, reason: `这一轮你已经回复过一次，请等 ${lead} 下一次发言。` };
  if ([...allowed.values()].some((c) => c.round === round && c.senderId === sender.id)) {
    return { allow: false, reason: '你上一条回复还没有结果，请等它存下或被拒绝后再说。' };
  }
  allowed.set(checkId, { clusterId, senderId: sender.id, lead: false, round });
  return { allow: true };
}

function settled({ checkId, stored: wasStored }) {
  const c = allowed.get(checkId);
  if (!c) return;
  allowed.delete(checkId);
  if (!wasStored) return;   // refused by another plugin or rejected by the Hub: the turn is not used
  if (c.lead) { rounds.set(c.clusterId, { replied: new Set() }); return; }
  c.round.replied.add(c.senderId);
  const counts = stored.get(c.clusterId) ?? new Map();
  counts.set(c.senderId, (counts.get(c.senderId) ?? 0) + 1);
  stored.set(c.clusterId, counts);
}

async function kickoff({ clusterId, topic }) {
  const { members } = await host('host.members.list', { clusterId });
  const names = members.filter((m) => !m.hidden && m.name !== lead).map((m) => m.name);
  // Before the send: a member's reply can reach this plugin right behind the send's answer.
  rounds.set(clusterId, { replied: new Set() });
  const sent = await host('host.messages.send', { clusterId, body: `${names.map((name) => `@${name}`).join(' ')} ${topic}` });
  return { messageId: sent.messageId, mentioned: names, wakes: writeSettings?.mentionEnabled === true };
}

const commands = {
  kickoff,
  count: ({ clusterId }) => ({ round: [...(rounds.get(clusterId)?.replied ?? [])], stored: Object.fromEntries(stored.get(clusterId) ?? []),
    undecided: [...allowed.values()].filter((c) => c.clusterId === clusterId).length }),
  settings: () => writeSettings,
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.method) {   // an answer to one of this plugin's host requests
    const call = calls.get(message.id);
    calls.delete(message.id);
    if ('error' in message) call?.reject(new Error('host request refused')); else call?.resolve(message.result);
    return;
  }
  if (message.method === 'message.check.result') return settled(message.params);
  if (message.method === 'writeSettings.changed') { writeSettings = message.params.writeSettings; return; }
  if (message.method === 'event' || !message.id) return;
  if (message.method === 'initialize') {
    writeSettings = message.params.writeSettings ?? null;
    return send({ id: message.id, result: { apiVersion: 1, notifications: ['message.check.result', 'writeSettings.changed'] } });
  }
  if (message.method === 'shutdown') return send({ id: message.id, result: {} });
  if (message.method === 'message.check') {
    const verdict = check(message.params);
    const answer = () => {
      send({ id: message.id, result: verdict });
      if (verdict.allow) setTimeout(() => allowed.delete(message.params.checkId), undecidedMs);
    };
    if (verdict.allow && message.params.sender.name !== lead && delayFirstReplyMs && !delayedOnce) {
      delayedOnce = true;
      return void setTimeout(answer, delayFirstReplyMs);
    }
    return answer();
  }
  const command = message.method === 'invoke' ? commands[message.params.command] : undefined;
  if (!command) return send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  Promise.resolve().then(() => command(message.params.arguments ?? {}))
    .then((result) => send({ id: message.id, result: result ?? null }), () => send({ id: message.id, error: { code: -32000, message: 'failed' } }));
});
