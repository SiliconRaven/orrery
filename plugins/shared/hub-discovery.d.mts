// Types for hub-discovery.mjs (TypeScript callers: the Claude bridge and the tests). The plug-ins' copies need none.
import type { Agent, IncomingMessage } from 'node:http';

export declare const SIGNATURE_HEADER: 'x-orrery-sig';
export declare const SECRET_HEADER: 'x-orrery-bridge';

export type HubTarget =
  | { mode: 'signed'; hubId: string; claim: string; url: string; name: string; secret?: string }
  | { mode: 'legacy'; url: string; name: string; file: string; secret?: string };

export declare class HubError extends Error {
  kind: 'not-sent' | 'rejected' | 'unreachable';
  reason?: string;
  status?: number;
  sent: boolean;
  timeout?: boolean;
  hub?: HubTarget;
  constructor(kind: HubError['kind'], message: string, extra?: Record<string, unknown>);
}

type Env = Record<string, string | undefined>;
interface RequestOptions {
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Env;
  log?: (message: string) => void;
  hub?: HubTarget;
  agent?: Agent;
}

export declare function registryDirOf(env?: Env): string;
export declare function readBridgeKey(env?: Env): string;
export declare function findHub(opts?: { env?: Env; secret?: boolean; log?: (message: string) => void }): HubTarget;
export declare function callOutcome(e: unknown): string;
export declare function hubUrl(opts?: { env?: Env; log?: (message: string) => void }): string;
export declare function signRequest(hub: HubTarget, method: string, path: string, headers?: Record<string, string>,
  body?: Uint8Array, ts?: string, nonce?: string): string;
export declare function hubFetch(method: string, path: string, opts?: RequestOptions & { maxBytes?: number }):
  Promise<{ status: number; text: string; hub: HubTarget }>;
export declare function hubStream(path: string, opts?: RequestOptions): Promise<{ res: IncomingMessage; hub: HubTarget }>;
