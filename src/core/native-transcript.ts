export const TRANSCRIPT_MAX_ITEMS = 200;
export const TRANSCRIPT_TEXT_BYTES = 16 * 1024;

export interface TranscriptRequest {
  direction?: 'before' | 'after';
  /** Use the preceding page's cursor for this direction. Omit it to read the latest page. */
  cursor?: string;
  limit?: number;
}

export type TranscriptStatus = 'ok' | 'reset' | 'missing' | 'unsupported' | 'archived' | 'refused';
export type TranscriptKind = 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result'
  | 'orrery_delivery' | 'orrery_post' | 'system' | 'unknown';

export interface TranscriptDeliveryPart {
  messageId: string;
  from: string;
  kind: string;
  body: string;
  private?: true;
  truncated?: boolean;
}

/** Adapter evidence for the Hub. Keep it out of the public response. */
export interface TranscriptSource {
  orrery?: boolean;
  deliveryId?: string;
  toolCallId?: string;
  toolName?: string;
  toolServer?: string;
  postMessageId?: string;
  /** Unverified evidence. The Hub turns the item into orrery_delivery only on a verified match; otherwise the item is returned unchanged. */
  candidate?: {
    /** Envelope text starting with `[orrery] cluster=…`; the adapter strips any host wrapper first. */
    envelope?: string;
    /** Exact delivery id. */
    deliveryId?: string;
    /** Direct send (no envelope). `body` is the delivered text. */
    direct?: { body: string; at?: string; deliveryIdPrefix?: string };
  };
}

export interface TranscriptItem {
  /** A later record with the same ID replaces the earlier record in the transcript. */
  id: string;
  kind: TranscriptKind;
  text?: string;
  timestamp?: string;
  truncated?: boolean;
  name?: string;
  /** Stable association between a tool call and its result. */
  callId?: string;
  parts?: TranscriptDeliveryPart[];
  messageId?: string;
  source?: TranscriptSource;
}

export interface TranscriptPage {
  status: TranscriptStatus;
  /** Items are always in file order, independent of the request direction. */
  items: TranscriptItem[];
  before?: string;
  /** Present on successful pages, including when waiting for the first complete record. */
  after?: string;
  /** There is more to scan in the requested direction. An empty page can still have a continuation. */
  hasMore: boolean;
  unknownCount: number;
}

export function emptyTranscriptPage(status: TranscriptStatus): TranscriptPage {
  return { status, items: [], hasMore: false, unknownCount: 0 };
}

export function truncateTranscriptText(text: string): { text: string; truncated?: true } {
  if (text.length <= TRANSCRIPT_TEXT_BYTES && Buffer.byteLength(text) <= TRANSCRIPT_TEXT_BYTES) return { text };
  const bytes = Buffer.from(text.slice(0, TRANSCRIPT_TEXT_BYTES));
  let end = Math.min(bytes.length, TRANSCRIPT_TEXT_BYTES);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.toString('utf8', 0, end), truncated: true };
}
