import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { bridgeModule, call, controlApi, inputModule, logError, logInfo, logWarn, readModelModule, reads, redactSecretText, sessionId } from './control-api-reads-context.js';

describe('activity log', () => {
  it('serves the newest entries, filtered by level and time', async () => {
    const marker = randomBytes(6).toString('hex');
    const before = Date.now() - 1;
    logInfo(`reads-test info ${marker}`);
    logWarn(`reads-test warn ${marker}`);
    logError(`reads-test error ${marker}`);

    const ours = (entries: Array<{ message: string; level: string }>) => entries.filter((entry) => entry.message.includes(marker)).map((entry) => entry.level);
    const all = await call(`/v1/log?since=${before}`);
    expect(ours(all.body.entries)).toEqual(['info', 'warn', 'error']);
    expect(all.body.ringSize).toBeGreaterThanOrEqual(3);
    expect(ours((await call(`/v1/log?since=${before}&level=warn,error`)).body.entries)).toEqual(['warn', 'error']);

    const last = await call('/v1/log?limit=1');
    expect(last.body.entries).toHaveLength(1);
    expect(all.body.entries.map((entry: { time: number }) => entry.time)).toEqual(all.body.entries.map((entry: { time: number }) => entry.time).sort((a: number, b: number) => a - b));
    expect((await call(`/v1/log?since=${Date.now() + 60_000}`)).body.entries).toEqual([]);
  });

  it('includes the line at the given time, so a caller cannot lose one written in the same millisecond', async () => {
    const marker = randomBytes(6).toString('hex');
    logInfo(`reads-test boundary ${marker}`);
    const { entries } = (await call('/v1/log?limit=500')).body;
    const mine = entries.find((entry: { message: string }) => entry.message.includes(marker));
    const again = await call(`/v1/log?since=${mine.time}&limit=500`);
    expect(again.body.entries.some((entry: { message: string }) => entry.message.includes(marker))).toBe(true);
  });

  it('masks credential shapes and cuts a very long line, and says so', () => {
    const [long] = reads.projectLog([{ time: 1, level: 'info', message: 'z'.repeat(9_000) }]);
    expect(long!.message).toHaveLength(4_000);
    expect(long!.truncated).toBe(true);
    const [masked] = reads.projectLog([{ time: 1, level: 'warn', message: `retry with Authorization: Bearer ${'t'.repeat(30)}`, agent: 'worker-1' }]);
    expect(masked).toEqual({ time: 1, level: 'warn', message: 'retry with Authorization: Bearer [redacted]', agent: 'worker-1' });
  });
});

describe('secret redaction', () => {
  const shapes: Record<string, string> = {
    'github token': `ghp_${'aB3'.repeat(12)}`,
    'github fine-grained token': `github_pat_${'aB3'.repeat(16)}`,
    'slack token': `xoxb-${'1234567890-'.repeat(3)}abc`,
    'aws access key': `AKIA${'Q'.repeat(16)}`,
    'google api key': `AIza${'x'.repeat(35)}`,
    'stripe key': `sk_live_${'a1'.repeat(12)}`,
    jwt: `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`
  };

  it.each(Object.entries(shapes))('masks a %s', (_name, secret) => {
    const out = redactSecretText(`before ${secret} after`);
    expect(out).toBe('before [redacted] after');
  });

  it('masks headers, URL passwords, private keys and MCP endpoint paths', () => {
    const token = 'k'.repeat(43);
    expect(redactSecretText(`curl -H "Authorization: Bearer ${token}" -H 'authorization: basic ZHVtbXk6ZHVtbXk='`)).toBe(
      'curl -H "Authorization: Bearer [redacted]" -H \'authorization: basic [redacted]\''
    );
    expect(redactSecretText(`Bearer ${token}`)).toBe('Bearer [redacted]');
    expect(redactSecretText('postgres://admin:hunter2@db.internal:5432/app')).toBe('postgres://[redacted]@db.internal:5432/app');
    expect(redactSecretText(`https://tunnel.example/mcp/core/${token}`)).toBe('https://tunnel.example/mcp/core/[redacted]');
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy', '-----END RSA PRIVATE KEY-----'].join('\n');
    expect(redactSecretText(`key:\n${pem}\ndone`)).toBe('key:\n[redacted private key]\ndone');
    expect(redactSecretText('-----BEGIN PRIVATE KEY-----\nMIIBOgIBAAJB')).toBe('[redacted private key]');
  });

  it('leaves hashes, ids and ordinary prose alone', () => {
    const untouched = [
      '9fceb02d0ae598e95dc970b74767f19372d61af8',
      randomUUID(),
      'Basic configuration is described in the implementation-details section',
      'The bearer of this note should read backend/control-reads.ts',
      'https://example.test/docs/mcp/overview',
      'user@example.test'
    ];
    for (const text of untouched) expect(redactSecretText(text)).toBe(text);
  });
});

describe('the deadline on reads', () => {
  const held: Array<() => void> = [];
  // An owner that never answers, until the test lets it fail.
  const stuck = () => new Promise<never>((_, reject) => held.push(() => reject(new Error('finished late'))));
  const release = async () => {
    for (const fail of held.splice(0)) fail();
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  const events = () => `/v1/sessions/${sessionId}/events`;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    controlApi.setReadDeadlineForTests(150);
  });
  afterEach(async () => {
    await release();
    process.off('unhandledRejection', onUnhandled);
    controlApi.setReadDeadlineForTests();
    vi.restoreAllMocks();
  });

  it('answers 504 when an owner never does, and health still answers meanwhile', async () => {
    vi.spyOn(inputModule, 'listInputs').mockImplementation(stuck);
    const started = Date.now();
    const reply = await call('/v1/inputs');
    expect(reply).toEqual({ status: 504, body: { error: 'timeout', detail: expect.any(String) } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await call('/v1/health')).status).toBe(200);
  });

  it('covers the status route as well', async () => {
    vi.spyOn(bridgeModule, 'bridgeStatus').mockImplementation(stuck);
    expect(await call('/v1/status')).toMatchObject({ status: 504, body: { error: 'timeout' } });
  });

  it('leaves no rejection behind when the stuck read fails after it was answered', async () => {
    vi.spyOn(inputModule, 'listInputs').mockImplementation(stuck);
    expect((await call('/v1/inputs')).status).toBe(504);
    await release();
    expect(unhandled).toEqual([]);
  });

  it('keeps a stuck journal read in its place until it ends, so answering early cannot pile them up', async () => {
    const stuckPage = vi.spyOn(readModelModule, 'readSessionEvents').mockImplementation(stuck);
    const first = await Promise.all([call(events()), call(events())]);
    expect(first.map((reply) => reply.status)).toEqual([504, 504]);
    // Both places are still taken: the reads were answered, not finished.
    expect(await call(events())).toMatchObject({ status: 503, body: { error: 'busy' } });
    // The reads that follow are meant to finish, so they get a deadline no runner will reach.
    controlApi.setReadDeadlineForTests(5_000);
    expect((await call('/v1/inputs')).status).toBe(200);
    await release();
    stuckPage.mockRestore();
    expect((await call(events())).status).toBe(200);
  });

  it('refuses new reads at once when enough are stuck, so polling cannot queue work behind an owner', async () => {
    const owner = vi.spyOn(inputModule, 'listInputs').mockImplementation(stuck);
    const answered = await Promise.all(Array.from({ length: 8 }, () => call('/v1/inputs')));
    expect(answered.map((reply) => reply.status)).toEqual(Array(8).fill(504));
    // Every place is held by a read that was answered but has not finished. A 503 and not a 504: these were turned away, not left to wait for the deadline.
    expect(await call('/v1/inputs')).toMatchObject({ status: 503, body: { error: 'busy' } });
    expect(await call('/v1/log')).toMatchObject({ status: 503, body: { error: 'busy' } });
    expect(owner).toHaveBeenCalledTimes(8);
    expect((await call('/v1/health')).status).toBe(200);
    await release();
    owner.mockRestore();
    controlApi.setReadDeadlineForTests(5_000);
    expect((await call('/v1/inputs')).status).toBe(200);
  });

  it('holds one timer per read and clears it once the request is answered, whatever its outcome', async () => {
    controlApi.setReadDeadlineForTests(60_000);
    const set = vi.spyOn(globalThis, 'setTimeout');
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    const owner = vi.spyOn(inputModule, 'listInputs');
    const cases: Array<[string, number]> = [
      ['/v1/inputs', 200],
      ['/v1/sessions/2026-01-01-deadbeef', 404],
      ['/v1/inputs?limit=0', 400],
      ['/v1/log', 200]
    ];
    for (const [route, status] of cases) {
      set.mockClear();
      cleared.mockClear();
      expect((await call(route)).status, route).toBe(status);
      const mine = set.mock.calls.flatMap((args, index) => (args[1] === 60_000 ? [set.mock.results[index]!.value] : []));
      expect(mine, route).toHaveLength(1);
      expect(cleared.mock.calls.map((args) => args[0]), route).toContain(mine[0]);
    }
    // An owner that fails outright still leaves no timer behind.
    owner.mockRejectedValueOnce(new Error('the outbox failed'));
    set.mockClear();
    cleared.mockClear();
    expect((await call('/v1/inputs')).status).toBe(500);
    const failed = set.mock.calls.flatMap((args, index) => (args[1] === 60_000 ? [set.mock.results[index]!.value] : []));
    expect(failed).toHaveLength(1);
    expect(cleared.mock.calls.map((args) => args[0])).toContain(failed[0]);
  });

  it('does not touch a read that finishes in time', async () => {
    controlApi.setReadDeadlineForTests(5_000);
    expect((await call('/v1/inputs')).status).toBe(200);
    expect((await call(events())).status).toBe(200);
  });
});
