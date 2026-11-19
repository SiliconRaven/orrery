import type { IncomingMessage } from 'node:http';

const verifiedBodies = new WeakMap<IncomingMessage, Buffer>();

export function rememberBridgeBody(req: IncomingMessage, body: Buffer): void {
  verifiedBodies.set(req, body);
}

export function signedBridgeBody(req: IncomingMessage): Buffer | undefined {
  return verifiedBodies.get(req);
}

/** Signed routes reuse the exact bytes read during authentication and still enforce their own limits. */
export async function readBridgeBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const verified = verifiedBodies.get(req);
  if (verified) {
    if (verified.length > max) throw new Error('body too large');
    return verified;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) {
      req.resume();
      throw new Error('body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
