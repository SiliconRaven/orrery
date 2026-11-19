import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { bridgeMac, SECRET_HEADER, SIGNATURE_HEADER, type BridgeTarget } from '../bridge-protocol.ts';
import { readBridgeBody, rememberBridgeBody } from './request-body.ts';

const AUTH_WINDOW_MS = 60_000;
const NONCE_WINDOW_MS = 120_000;
const MAX_SIGNED_BODY = 4 * 1024 * 1024; // MCP SDK HTTP body limit
const SIGNATURE_RE = /^v1 ([a-f0-9-]{36}) ([a-f0-9]{32}) ([1-9][0-9]{0,15}) ([a-f0-9]{32}) ([a-f0-9]{64})$/;

export type BridgeAuth = { kind: 'signed' | 'legacy' } | { kind: 'rejected'; reason?: 'claim' | 'expired' | 'replay' | 'mac' | 'host' };

/** Node discards or joins duplicate headers; verify the single wire value that the handlers will use. */
function signedHeaders(req: IncomingMessage): Map<string, string> | null {
  const headers = new Map<string, string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    if (name !== 'host' && !name.startsWith('x-orrery-')) continue;
    const value = req.rawHeaders[i + 1];
    if (headers.has(name) || value !== req.headers[name] || !/^[\x20-\x7e]+$/.test(value)
      || value !== value.trim() || value.includes(',')) return null;
    headers.set(name, value);
  }
  return headers;
}

function unambiguousTarget(target: string): boolean {
  if (!/^\/(?:mcp(?:\?|$)|bridge\/)/.test(target) || /[#\\\x00-\x20\x7f]/.test(target)) return false;
  const url = new URL(target, 'http://localhost');
  if (url.pathname + url.search !== target || url.pathname.includes('%')) return false;
  const keys = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

export function createBridgeAuthenticator(secret: string, target: BridgeTarget, allowLegacy: () => boolean) {
  const host = target.url.slice(7);
  const port = Number(host.split(':')[1]);
  const used = new Map<string, number>();
  return async (req: IncomingMessage): Promise<BridgeAuth> => {
    const hasSignature = req.headers[SIGNATURE_HEADER] !== undefined;
    if (!hasSignature && (!allowLegacy() || req.headers[SECRET_HEADER] === undefined)) return { kind: 'rejected' };
    const headers = signedHeaders(req);
    if (!headers) return { kind: 'rejected', reason: hasSignature ? 'mac' : undefined };
    if (!hasSignature) {
      const given = Buffer.from(headers.get(SECRET_HEADER) ?? '');
      const expected = Buffer.from(secret);
      return given.length === expected.length && timingSafeEqual(given, expected)
        ? { kind: 'legacy' } : { kind: 'rejected' };
    }
    const match = SIGNATURE_RE.exec(headers.get(SIGNATURE_HEADER) ?? '');
    const path = req.url ?? '';
    if (!match || headers.has(SECRET_HEADER) || !req.method || !unambiguousTarget(path)) return { kind: 'rejected', reason: 'mac' };
    if (headers.get('host') !== host || req.socket.localPort !== port) {
      return { kind: 'rejected', reason: 'host' };
    }
    const [, hubId, claim, ts, nonce, mac] = match;
    if (hubId !== target.hubId || claim !== target.claim) return { kind: 'rejected', reason: 'claim' };
    if (!Number.isSafeInteger(Number(ts)) || Math.abs(Date.now() - Number(ts)) > AUTH_WINDOW_MS) return { kind: 'rejected', reason: 'expired' };
    const previous = used.get(nonce);
    if (previous !== undefined && performance.now() - previous <= NONCE_WINDOW_MS) return { kind: 'rejected', reason: 'replay' };
    let body: Buffer;
    try { body = await readBridgeBody(req, MAX_SIGNED_BODY); }
    catch { return { kind: 'rejected', reason: 'mac' }; }
    if (Math.abs(Date.now() - Number(ts)) > AUTH_WINDOW_MS) return { kind: 'rejected', reason: 'expired' };
    const expected = bridgeMac(secret, target, req.method, path, headers, ts, nonce, body);
    if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))) return { kind: 'rejected', reason: 'mac' };
    const now = performance.now();
    for (const [seen, time] of used) {
      if (now - time <= NONCE_WINDOW_MS) break;
      used.delete(seen);
    }
    if (used.has(nonce)) return { kind: 'rejected', reason: 'replay' };
    used.set(nonce, now);
    rememberBridgeBody(req, body);
    return { kind: 'signed' };
  };
}
