// orrery's signed tickets (src/mcp/wait-core.ts: <letter><digit>.<session id>.<64 hex HMAC>) are reusable: whoever has
// one can hold that session's wait. A transcript shows a harness's own record, which holds them in the wait command and
// its output, so every text an adapter returns goes through maskTickets; attribution keeps using the raw record.
import type { TranscriptDraft } from './transcript.ts';

const TICKET = /(?<![A-Za-z0-9._-])([a-z][0-9]\.[A-Za-z0-9._-]{1,128}\.)[0-9a-f]{64}(?![0-9a-f])/g;
export const TICKET_MASK = '<hidden>';

/** The text with the secret part of every orrery ticket replaced; the prefix and session id stay readable. */
export const maskTickets = (text: string): string => text.replace(TICKET, `$1${TICKET_MASK}`);

/** The items with every text masked; their sources (evidence for the Hub, never shown) keep the raw values. */
export const maskDrafts = (drafts: TranscriptDraft[]): TranscriptDraft[] =>
  drafts.map(draft => draft.text === undefined ? draft : { ...draft, text: maskTickets(draft.text) });
