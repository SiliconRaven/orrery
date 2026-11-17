// Who a native Antigravity caller is (docs/adapters/antigravity.md, "认人"). Antigravity has one MCP connection per app,
// shared by all its conversations, so the request itself names no conversation. The orrery PreToolUse hook that the
// user installs (plugins/antigravity-orrery/hook.mjs) writes `orreryCaller: "<conversation id>.<tag>"` into the
// arguments of every orrery tool call, overwriting whatever the model put there, with
//   tag = hex HMAC-SHA256(bridge secret, "orrery-antigravity-caller\n" + conversation id).
// The Hub takes the id only with a valid tag, and only from callers that present the bridge secret together with
// x-orrery-harness: antigravity; never from the arguments of any other caller. Without the hook (or when it did not
// run) the model can still write the field, but it cannot make a valid tag, so the call is refused.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const ANTIGRAVITY = 'antigravity';
export const CALLER_ARG = 'orreryCaller';
export const CALLER_ARG_HELP = 'Filled in by the orrery hook; leave it out.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG = /^[0-9a-f]{64}$/;

/** The hook's tag for a conversation id (the hook computes the same; test/antigravity-native.test.ts checks both agree). */
export function callerTag(secret: string, conversationId: string): string {
  return createHmac('sha256', secret).update(`orrery-antigravity-caller\n${conversationId}`).digest('hex');
}

/** The conversation id in a hook-signed `orreryCaller` value, or null when the value is missing, malformed or forged. */
export function signedConversation(secret: string, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  const id = value.slice(0, dot);
  const tag = value.slice(dot + 1);
  if (dot < 0 || !UUID.test(id) || !TAG.test(tag)) return null;
  return timingSafeEqual(Buffer.from(tag, 'hex'), Buffer.from(callerTag(secret, id), 'hex')) ? id : null;
}
