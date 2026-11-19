// Versioned wire format shared by the Hub and its local diagnostic clients.
import { createHash, createHmac, randomBytes } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-orrery-sig';
export const SECRET_HEADER = 'x-orrery-bridge';
export const HUB_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const CLAIM_RE = /^[a-f0-9]{32}$/;
export const BRIDGE_SECRET_RE = /^[a-f0-9]{64}$/;
const IDENTITY_HEADERS = ['x-orrery-harness', 'x-orrery-session'];

export interface BridgeTarget {
  hubId: string;
  claim: string;
  url: string;
}

/** Include both identity slots even when absent. The server rejects explicit empty identity headers. */
function signedHeaderLines(headers: ReadonlyMap<string, string>): string[] {
  const names = new Set(IDENTITY_HEADERS);
  for (const name of headers.keys()) {
    if (name.startsWith('x-orrery-') && name !== SIGNATURE_HEADER) names.add(name);
  }
  return [...names].sort().map((name) => `${name}:${headers.get(name) ?? ''}`);
}

export function bridgeMac(secret: string, target: BridgeTarget, method: string, path: string,
  headers: ReadonlyMap<string, string>, ts: string, nonce: string, body: Uint8Array): string {
  const digest = createHash('sha256').update(body).digest('hex');
  const canonical = ['orrery-req-v1', target.hubId, target.claim, target.url.slice(7), method, path,
    ...signedHeaderLines(headers), ts, nonce, digest].join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

export function signBridgeRequest(secret: string, target: BridgeTarget, method: string, path: string,
  headers: ReadonlyMap<string, string> = new Map(), body: Uint8Array = Buffer.alloc(0),
  ts = String(Date.now()), nonce = randomBytes(16).toString('hex')): string {
  return ['v1', target.hubId, target.claim, ts, nonce, bridgeMac(secret, target, method, path, headers, ts, nonce, body)].join(' ');
}
