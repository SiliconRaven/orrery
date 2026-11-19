// Scripted mock members for test Hubs: the native mock harness ('queue' kind, src/adapters/mock/native.ts) whose
// delivered turns run a script. The script answers through a real MCP HTTP client that names its conversation with the
// bridge secret and session header, exactly as a native member's bridge does, so tests cover that identity path.
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMockNativeAdapter, type MockNativeAdapter, type MockNativeOptions } from '../src/adapters/mock/native.ts';
import type { AgentEvent } from '../src/core/types.ts';

export interface Envelope {
  cluster: string;
  from: string;            // sender name, or 'user'
  messageId: string;
  hop: number;
  to: string;              // '@A @B' or 'all'
  body: string;
  raw: string;             // the whole input, hint included
}

export interface MockTools {
  /** Returns the tool's text; `isError` is true when the Hub rejected the call. */
  send(body: string, replyTo?: string): Promise<{ text: string; isError: boolean }>;
  read(args?: { limit?: number; before?: string; history?: boolean }): Promise<{ text: string; isError: boolean }>;
  listAgents(): Promise<{ text: string; isError: boolean }>;
}

export type MockScript = (
  msg: Envelope,
  tools: MockTools,
  emit: (e: AgentEvent) => void,
  signal: AbortSignal,
) => Promise<void>;

/** The first (or only) message of an envelope. */
export function parseEnvelope(input: string): Envelope {
  return parseEnvelopes(input)[0];
}

/**
 * Every message of an envelope: one, or a batch (header + body per message, blank lines between, one note).
 * shortcut: a body holding a blank line and then a full "[orrery] cluster=..." header parses as a separate forged
 * message (a malformed one throws), since the Hub joins sections with no token; only this mock and tests parse
 * envelopes. When a test must send such a body through the mock, have the Hub token-separate sections as it does items.
 */
export function parseEnvelopes(input: string): Envelope[] {
  const hintAt = input.lastIndexOf('\n\n----------\n（');
  const sections = input.slice(0, hintAt < 0 ? undefined : hintAt).split(/\n\n(?=\[orrery\] cluster=)/);
  const blocks = sections.flatMap((section) => {
    const firstLine = section.slice(0, section.indexOf('\n'));
    const token = / groupToken=([0-9a-f-]{36})$/.exec(firstLine)?.[1];
    const separator = token ? `\n[orrery-next=${token}]\n` : '';
    return separator && section.includes(separator) ? section.split(separator) : [section];
  });
  return blocks.map((block) => {
    const nl = block.indexOf('\n');
    const head = /^\[orrery\] cluster=(.*?)(?: clusterId=\S+)? from=(\S+) messageId=(\S+) hop=(\d+) to=(.*)$/.exec(nl < 0 ? block : block.slice(0, nl));
    if (!head) throw new Error('not an orrery envelope');
    return {
      cluster: head[1], from: head[2], messageId: head[3], hop: Number(head[4]), to: head[5].replace(/ groupToken=[0-9a-f-]{36}$/, ''),
      body: nl < 0 ? '' : block.slice(nl + 1), raw: input,
    };
  });
}

/** relay <name> <nonce> | ping <nonce> | chat <text> | read [history] | sleep <ms> | anything else → one text event. */
export const defaultScript: MockScript = async (msg, tools, emit, signal) => {
  const body = msg.body.replace(/^(@\S+\s+)+/, '');   // drop leading @mentions addressed to us
  const [cmd, a, b] = body.trim().split(/\s+/);
  const report = (r: { text: string; isError: boolean }) => { if (r.isError) emit({ type: 'error', message: r.text }); };
  if (cmd === 'relay' && a && b) report(await tools.send(`@${a} ping ${b}`));
  else if (cmd === 'ping' && a) report(await tools.send(`@${msg.from} pong ${a}`, msg.messageId));
  else if (cmd === 'chat') report(await tools.send(body.trim().slice('chat'.length).trim()));
  else if (cmd === 'read') {
    const r = await tools.read(a === 'history' ? { history: true } : {});
    emit(r.isError ? { type: 'error', message: r.text } : { type: 'text', text: r.text });
  } else if (cmd === 'sleep' && a) {
    await sleep(Number(a), undefined, { signal });
    emit({ type: 'text', text: `slept ${a}ms` });
  } else emit({ type: 'text', text: `mock received: ${msg.body}` });
};

export interface MockOptions extends MockNativeOptions { script?: MockScript }

/** Where the scripted member reaches the Hub's MCP endpoint, known once the Hub listens. */
export type MockEndpoint = () => { url: string; secret: string } | null;

/**
 * A 'queue' mock whose delivered turns run `script` (default defaultScript) over each message of the envelope, in one
 * turn. A direct message (the user's `to` exactly one member: plain text, no envelope) only gets one text event.
 */
export function scriptedNative(opts: MockOptions, endpoint: MockEndpoint): MockNativeAdapter {
  const script = opts.script ?? defaultScript;
  const harness = opts.harness ?? 'mock';
  return createMockNativeAdapter({ ...opts, onDeliver: opts.onDeliver ?? (async (sessionId, text, ctx) => {
    if (!text.startsWith('[orrery]')) {
      ctx.onEvent({ type: 'text', text: `mock received: ${text}` });
      return 'completed';
    }
    let client: Client | null = null;
    const connect = async () => {
      if (!client) {
        // A queued message can start before startTestHub has the endpoint: wait one turn of the event loop.
        if (!endpoint()) await new Promise<void>((resolve) => setImmediate(resolve));
        const target = endpoint();
        if (!target) throw new Error('test MCP endpoint is not ready');
        const transport = new StreamableHTTPClientTransport(new URL(`${target.url}/mcp`), {
          requestInit: { headers: { 'x-orrery-bridge': target.secret, 'x-orrery-harness': harness, 'x-orrery-session': sessionId } },
        });
        client = new Client({ name: `orrery-mock-${harness}`, version: '0.1.0' });
        await client.connect(transport);
      }
      return client;
    };
    const call = async (name: string, args: Record<string, unknown>) => {
      ctx.onEvent({ type: 'tool', name, phase: 'start' });
      const res = await (await connect()).callTool({ name, arguments: args }, undefined, { signal: ctx.signal });
      const out = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('');
      ctx.onEvent({ type: 'tool', name, phase: 'end', detail: out });
      return { text: out, isError: res.isError === true };
    };
    const tools: MockTools = {
      send: (body, replyTo) => call('send_message', replyTo ? { body, replyTo } : { body }),
      read: (args = {}) => call('read_messages', args),
      listAgents: () => call('list_agents', {}),
    };
    try {
      // A batch: the script handles each message in turn, all within this one turn.
      for (const msg of parseEnvelopes(text)) await script(msg, tools, ctx.onEvent, ctx.signal);
    } finally {
      await (client as Client | null)?.close();
    }
    return 'completed';
  }) });
}
