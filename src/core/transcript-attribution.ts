import { createHmac, timingSafeEqual } from 'node:crypto';
import { truncateTranscriptText, type TranscriptItem, type TranscriptSource } from './native-transcript.ts';
import type { Store, StoredMember } from './store.ts';
import type { Message } from './types.ts';

function cursorTag(key: string, binding: string, cursor: string): string {
  return createHmac('sha256', key).update(binding).update('\0').update(cursor).digest('hex');
}

export function transcriptCursor(key: string, binding: string, cursor: string): string {
  return `${cursor}.${cursorTag(key, binding, cursor)}`;
}

export function openTranscriptCursor(key: string, binding: string, token: string): string | null {
  const sep = token.lastIndexOf('.');
  const tag = token.slice(sep + 1);
  if (sep <= 0 || !/^[0-9a-f]{64}$/.test(tag)) return null;
  const cursor = token.slice(0, sep);
  return timingSafeEqual(Buffer.from(tag, 'hex'), Buffer.from(cursorTag(key, binding, cursor), 'hex')) ? cursor : null;
}

function envelopeHeader(text: string): { clusterId: string; messageId: string; hop: number } | null {
  // The native adapter has already stripped the Claude peer wrapper. Only the packet's first line is evidence.
  const first = text.split('\n', 1)[0];
  const match = /^\[orrery\] cluster=.* clusterId=([^\s=]+) from=[^=]* messageId=([^\s=]+) hop=(\d{1,16}) to=\S/.exec(first);
  if (!match) return null;
  return { clusterId: match[1], messageId: match[2], hop: Number(match[3]) };
}

function deliveryItem(item: TranscriptItem, messages: Message[]): TranscriptItem {
  if (!messages.length) return { ...item, kind: 'orrery_delivery', parts: [] };
  // All parts come from the scoped batch. The rendered envelope may be truncated, grouped, or contain
  // attachments, hints and other lines that do not belong in the group message bodies.
  const { text: _text, truncated: _truncated, ...meta } = item;
  return { ...meta, kind: 'orrery_delivery', parts: messages.map((message) => {
    const { text: body, truncated } = truncateTranscriptText(message.body);
    return { messageId: message.id, from: message.from, kind: message.kind ?? 'chat', body,
      ...(message.privateTo ? { private: true as const } : {}), ...(truncated ? { truncated } : {}) };
  }) };
}

const CANDIDATE_KINDS = new Set<TranscriptItem['kind']>(['user', 'system', 'tool_result']);

/**
 * Unverified adapter evidence (harnesses without a trusted host marker). Only a Hub record of a delivery to this
 * membership in its own cluster counts; every miss returns null so the caller keeps the item unchanged.
 * Precedence: deliveryId, then envelope, then direct.
 */
function candidateDelivery(store: Store, member: StoredMember, candidate: NonNullable<TranscriptSource['candidate']>): Message[] | null {
  if (typeof candidate.deliveryId === 'string' && candidate.deliveryId) {
    const batch = store.transcriptDeliveryBatch(member, { batchId: candidate.deliveryId });
    if (batch.length) return batch;
  }
  if (typeof candidate.envelope === 'string') {
    const header = envelopeHeader(candidate.envelope);
    const batch = header?.clusterId === member.clusterId ? store.transcriptDeliveryBatch(member, header) : [];
    if (batch.length) return batch;
  }
  const direct = candidate.direct;
  if (direct && typeof direct.body === 'string') {
    const { body, at, deliveryIdPrefix: prefix } = direct;
    if (prefix !== undefined && !/^[0-9a-f]{8}[0-9a-f-]*$/i.test(prefix)) return null;
    if (at !== undefined && !Number.isFinite(Date.parse(at))) return null;
    const normPrefix = prefix?.toLowerCase();
    const found = store.transcriptDirectDelivery(
      member, body, at === undefined ? undefined : new Date(at).toISOString(), normPrefix,
    );
    if (!found?.message) return null;
    if (normPrefix !== undefined && !found.deliveryId?.toLowerCase().startsWith(normPrefix)) return null;
    return [found.message];
  }
  return null;
}

function isSendMessage(source: TranscriptSource): boolean {
  const { toolName, toolServer } = source;
  return !!toolServer && (toolName === 'send_message' || toolName === `mcp__${toolServer}__send_message`);
}

/** Link trusted native evidence to existing group records. Source hints are for the Hub only. */
export function attributeTranscript(store: Store, member: StoredMember, items: TranscriptItem[]): TranscriptItem[] {
  const sends = new Set<string>();
  return items.map(({ source, parts: _parts, messageId: _messageId, ...item }) => {
    if (!source) return item;
    if (item.kind === 'user' && source.deliveryId) {
      const batch = store.transcriptDeliveryBatch(member, { batchId: source.deliveryId });
      if (batch.length) return deliveryItem(item, batch);
    }
    if (item.kind === 'user' && source.orrery) {
      if (item.text !== undefined && !item.truncated && item.timestamp && Number.isFinite(Date.parse(item.timestamp))) {
        const direct = store.transcriptDirectDelivery(member, item.text, new Date(item.timestamp).toISOString());
        if (direct) return deliveryItem(item, direct.message ? [direct.message] : []);
      }
      const header = item.text === undefined ? null : envelopeHeader(item.text);
      return deliveryItem(item, header?.clusterId === member.clusterId ? store.transcriptDeliveryBatch(member, header) : []);
    }
    if (source.candidate && CANDIDATE_KINDS.has(item.kind)) {
      const messages = candidateDelivery(store, member, source.candidate);
      return messages ? deliveryItem(item, messages) : item;
    }

    const callId = source.toolCallId ?? item.callId;
    const isSend = isSendMessage(source);
    if (item.kind === 'tool_call' && callId && isSend) sends.add(callId);
    const linkedCall = !source.toolName && !source.toolServer && callId && sends.has(callId);
    if (item.kind === 'tool_result' && source.postMessageId && (isSend || linkedCall)) {
      const message = store.getMessage(source.postMessageId);
      // A send_message with task links is stored as a task comment by Hub.post.
      const kind = message?.kind ?? 'chat';
      if (message?.clusterId === member.clusterId && message.from === member.id && (kind === 'chat' || kind === 'task_comment')) {
        return { ...item, kind: 'orrery_post', messageId: message.id };
      }
    }
    return item;
  });
}
