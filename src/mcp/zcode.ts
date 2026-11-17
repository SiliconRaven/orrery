// Native ZCode (docs/adapters/zcode.md). The tickets, wait connections and wait command are the shared background-wait
// route (./wait-core.ts) with ZCode's settings; what is ZCode's own stays here: who a ZCode MCP caller is,
// _meta.root_session_id ?? _meta.session_id, flat or under "com.zcode/request-context", and whether that is a subagent
// or a remote workspace (wait_for_messages refuses both).
import type { Hub } from '../core/hub.ts';
import { ZCODE_WAIT } from '../core/types.ts';
import * as core from './wait-core.ts';

export { ARM_LIMIT, ARM_WINDOW_MS, hubUrlOf, NOT_MEMBER_TEXT, tail, TICKET_HEADER, WAIT_DESCRIPTION, WAIT_SCRIPT } from './wait-core.ts';

export const ZCODE = ZCODE_WAIT.harness;

export const ticketFor = (secret: string, sessionId: string): string => core.ticketFor(ZCODE_WAIT, secret, sessionId);

export const ticketSession = (secret: string, ticket: unknown): string | null => core.ticketSession(ZCODE_WAIT, secret, ticket);

export const waitCommand = (ticket: string, hubUrl: string, script?: string): string => core.waitCommand(ZCODE_WAIT, ticket, hubUrl, script);

/** The wait registry of this Hub for ZCode, made on first use. */
export const waitsOf = (hub: Hub, secret: string): core.WaitRegistry => core.waitsOf(ZCODE_WAIT, hub, secret);

/** Who a ZCode tools/call is, from the runtime's _meta (models cannot set it). Null: no session named. */
export function zcodeCaller(meta: Record<string, unknown> | undefined): { sessionId: string; subagent: boolean; remote: boolean } | null {
  const ctx = meta?.['com.zcode/request-context'];
  const nested = typeof ctx === 'object' && ctx !== null ? ctx as Record<string, unknown> : {};
  const session = core.metaSession(ZCODE_WAIT.metaKey, meta, nested);
  const root = core.metaSession('root_session_id', meta, nested);
  const sessionId = root ?? session;
  if (!sessionId) return null;
  const ws = meta?.workspace_identity ?? nested.workspace_identity;
  const remote = ws !== undefined && ws !== null && ws !== '' && !(typeof ws === 'object' && Object.keys(ws).length === 0);
  return { sessionId, subagent: root !== undefined && session !== undefined && root !== session, remote };
}
