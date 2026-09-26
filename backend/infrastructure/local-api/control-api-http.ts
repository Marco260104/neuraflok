import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const MAX_BODY_BYTES = 512 * 1024;

export function reply(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(text);
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function readBody(req: http.IncomingMessage, res: http.ServerResponse, timeoutMs: number): Promise<Buffer | null> {
  const declared = req.headers['content-length'];
  if (req.headers['transfer-encoding'] !== undefined || req.headers['content-encoding'] !== undefined) {
    reply(res, 400, { error: 'invalid_framing' }, { connection: 'close' });
    return Promise.resolve(null);
  }
  if (declared !== undefined && !/^\d{1,9}$/.test(declared)) {
    reply(res, 400, { error: 'invalid_framing' }, { connection: 'close' });
    return Promise.resolve(null);
  }
  const length = declared === undefined ? 0 : Number(declared);
  if (length > MAX_BODY_BYTES) {
    reply(res, 413, { error: 'body_too_large' }, { connection: 'close' });
    return Promise.resolve(null);
  }
  if (length > 0 && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
    reply(res, 415, { error: 'unsupported_media_type' }, { connection: 'close' });
    return Promise.resolve(null);
  }
  if (length === 0) return Promise.resolve(Buffer.alloc(0));
  if (/(?:^|\W)100-continue(?:$|\W)/i.test(req.headers.expect ?? '')) res.writeContinue();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const finish = (value: Buffer | null): void => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onGone);
      req.off('aborted', onGone);
      resolve(value);
    };
    const timer = setTimeout(() => {
      reply(res, 408, { error: 'body_timeout' }, { connection: 'close' });
      finish(null);
    }, timeoutMs);
    const onData = (chunk: Buffer): void => { chunks.push(chunk); };
    const onEnd = (): void => finish(Buffer.concat(chunks));
    const onGone = (): void => finish(null);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onGone);
    req.on('aborted', onGone);
  });
}
