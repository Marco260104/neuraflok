import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { call, chatSession, closedByServer, controlApi, actionGate as gate, outbox, port, post, row, seed, sendBody, startInput, token } from './control-api-actions-context.js';
import type { Reply } from './control-api-actions-context.js';

describe('with actions switched off', () => {
  it('answers every action route the same way, before reading anything, and changes nothing', async () => {
    gate.actions = false;
    await seed([row({ id: '00000000-0000-4000-8000-000000000001', text: 'queued before' })]);
    const before = JSON.stringify(await outbox());
    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    const cancels = vi.spyOn(startInput, 'cancelDesktopInput');
    try {
      const replies = [
        await post('/v1/inputs', sendBody()),
        await post('/v1/inputs', { nonsense: true }),
        await post('/v1/inputs/00000000-0000-4000-8000-000000000001/cancel'),
        await post('/v1/inputs/ffffffff-ffff-4fff-8fff-ffffffffffff/cancel', { anything: 1 }),
        await post('/v1/inputs/not-even-an-id/cancel'),
        // Announces far more body than it sends, and names no content type.
        await call('POST', '/v1/inputs', { body: '{}', headers: { 'content-length': '5000000', 'content-type': '' } }),
        await call('POST', '/v1/inputs', { body: 'not json', headers: { 'content-type': 'text/plain' } })
      ];
      for (const reply of replies) {
        expect(reply.status).toBe(403);
        expect(reply.raw).toBe(replies[0]!.raw);
        expect(reply.headers.connection).toBe('close');
      }
      expect(replies[0]!.body).toEqual({ error: 'actions_disabled' });
      expect(sends).not.toHaveBeenCalled();
      expect(cancels).not.toHaveBeenCalled();
      expect(JSON.stringify(await outbox())).toBe(before);
    } finally {
      sends.mockRestore();
      cancels.mockRestore();
    }
  });

  it('does not invite a body with 100 Continue, and reads are unaffected', async () => {
    gate.actions = false;
    const refused = await call('POST', '/v1/inputs', { body: JSON.stringify(sendBody()), headers: { expect: '100-continue' } });
    expect(refused.status).toBe(403);
    expect(refused.continued).toBe(false);
    expect((await call('GET', '/v1/inputs')).status).toBe(200);
    expect((await call('GET', '/v1/health')).body.actions).toEqual({ enabled: false, routes: ['POST /v1/inputs', 'POST /v1/inputs/{id}/cancel'] });
  });

  it('follows the switch on the next request without restarting the listener', async () => {
    gate.actions = false;
    expect((await post('/v1/inputs', { nonsense: true })).status).toBe(403);
    gate.actions = true;
    const now = await post('/v1/inputs', { nonsense: true });
    expect(now.status).toBe(400);
    expect((await call('GET', '/v1/health')).body.actions.enabled).toBe(true);
  });
});

describe('who may call', () => {
  it.each([false, true])('refuses a missing token, a wrong token, an Origin and a foreign Host (actions on: %s)', async (on) => {
    gate.actions = on;
    const body = JSON.stringify(sendBody());
    expect((await call('POST', '/v1/inputs', { body, auth: false })).status).toBe(401);
    expect((await call('POST', '/v1/inputs', { body, headers: { authorization: 'Bearer ' + token.slice(1) + 'x' } })).status).toBe(401);
    expect((await call('POST', '/v1/inputs', { body, headers: { origin: 'https://chatgpt.com' } })).status).toBe(403);
    expect((await call('POST', '/v1/inputs', { body, headers: { origin: 'chrome-extension://abc' } })).body).toEqual({ error: 'origin_forbidden' });
    expect((await call('POST', '/v1/inputs', { body, headers: { host: 'attacker.example' } })).body).toEqual({ error: 'host_forbidden' });
    expect((await call('POST', '/v1/inputs/' + randomUUID() + '/cancel', { auth: false })).status).toBe(401);
    expect(await outbox()).toEqual([]);
  });

  it('names the right method for each path', async () => {
    const put = await call('PUT', '/v1/inputs', { body: '{}' });
    expect(put.status).toBe(405);
    expect(put.headers.allow).toBe('GET, POST');
    const get = await call('GET', '/v1/inputs/' + randomUUID() + '/cancel');
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect((await call('POST', '/v1/status', { body: '{}' })).headers.allow).toBe('GET');
    expect((await call('DELETE', '/v1/inputs/' + randomUUID() + '/cancel')).headers.allow).toBe('POST');
  });
});

describe('the request body', () => {
  it('is refused before anything reaches the outbox when it is not a small JSON object', async () => {
    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const wrongType = await call('POST', '/v1/inputs', { body: JSON.stringify(sendBody()), headers: { 'content-type': 'text/plain' } });
      expect(wrongType.status).toBe(415);
      const charset = await call('POST', '/v1/inputs', { body: JSON.stringify(sendBody()), headers: { 'content-type': 'application/json; charset=utf-8' } });
      expect(charset.status).toBe(202);
      await seed([]);

      // The longest message the app accepts, every character escaped as \u0001, still fits.
      expect((await call('POST', '/v1/inputs', { body: JSON.stringify(sendBody({ text: '\u0001'.repeat(64_000) })) })).status).toBe(202);
      await seed([]);

      const huge = await call('POST', '/v1/inputs', { body: '{}', headers: { 'content-length': String(600 * 1024) } });
      expect(huge.status).toBe(413);
      expect(huge.headers.connection).toBe('close');
      // This caller keeps uploading after the refusal, so it may see its connection reset instead of the 413, as `readBody` documents. Windows does this whenever the refused bytes are unread.
      const uploading = await call('POST', '/v1/inputs', { body: JSON.stringify(sendBody({ text: 'x'.repeat(520 * 1024) })) });
      expect([413, 'reset']).toContain(uploading.reset ? 'reset' : uploading.status);

      const chunked = await new Promise<number>((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/inputs', method: 'POST',
          headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.write('{"id":');
        req.end('"x"}');
      });
      expect(chunked).toBe(400);

      expect((await call('POST', '/v1/inputs', { body: '{not json' })).body).toEqual({ error: 'invalid_json' });
      expect((await call('POST', '/v1/inputs', { body: Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]) })).body).toEqual({ error: 'invalid_json' });
      expect((await call('POST', '/v1/inputs?x=1', { body: JSON.stringify(sendBody()) })).body.error).toBe('invalid_query');
      // Only the two valid requests may have reached the owner.
      expect(sends).toHaveBeenCalledTimes(2);
    } finally {
      sends.mockRestore();
    }
  });

  it('is checked field by field, and unknown fields are refused', async () => {
    const cases: Array<[string, object]> = [
      ['no id', { sessionId: chatSession, text: 'x' }],
      ['uppercase id', sendBody({ id: randomUUID().toUpperCase() })],
      ['id that is not a uuid', sendBody({ id: 'not-a-uuid' })],
      ['bad session id', sendBody({ sessionId: '../etc' })],
      ['no text', { id: randomUUID(), sessionId: chatSession }],
      ['empty text', sendBody({ text: '' })],
      ['whitespace text', sendBody({ text: '  \n ' })],
      ['text over the limit', sendBody({ text: 'x'.repeat(64_001) })],
      ['text that is not a string', sendBody({ text: 42 })],
      ['interrupt that is not a boolean', sendBody({ interrupt: 'yes' })],
      ['a mode', sendBody({ mode: 'finish' })],
      ['a delivery flag', sendBody({ delivery: 'tool' })],
      ['a model', sendBody({ model: 'gpt-x' })],
      ['a due time', sendBody({ dueAt: 1 })],
      ['a project', sendBody({ projectId: randomUUID() })],
      ['images', sendBody({ images: [] })],
      ['attachments', sendBody({ attachments: [] })]
    ];
    for (const [name, body] of cases) {
      const reply = await post('/v1/inputs', body);
      expect(reply.status, name).toBe(400);
      expect(reply.body.error, name).toBe('invalid_body');
    }
    expect((await post('/v1/inputs', sendBody({ mode: 'finish' }))).body.detail).toBe('unknown field');
    expect((await post('/v1/inputs', [1, 2])).status).toBe(400);
    expect((await post('/v1/inputs', null)).status).toBe(400);
    expect((await post('/v1/inputs/' + randomUUID() + '/cancel', { reason: 'x' })).status).toBe(400);
    expect(await outbox()).toEqual([]);
  });

  it('is a 429 once a caller has spent its action budget', async () => {
    let last: Reply | null = null;
    for (let index = 0; index < 31; index += 1) last = await post('/v1/inputs', { nonsense: true });
    expect(last!.status).toBe(429);
    expect(last!.headers['retry-after']).toBe('60');
  });

  it('spends none of that budget on requests refused while actions are off', async () => {
    gate.actions = false;
    for (let index = 0; index < 60; index += 1) expect((await post('/v1/inputs', { nonsense: true })).status).toBe(403);
    gate.actions = true;
    for (let index = 0; index < 30; index += 1) expect((await post('/v1/inputs', { nonsense: true })).status).toBe(400);
    expect((await post('/v1/inputs', { nonsense: true })).status).toBe(429);
  });

  it('is answered 408 when a caller announces a body and does not send it', async () => {
    controlApi.setActionLimitsForTests({ bodyTimeoutMs: 150 });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/inputs', method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': '200' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', (error) => { if (closedByServer(error)) resolve(0); else reject(error); });
      req.write('{"id":');
    });
    expect(status).toBe(408);
    expect(await outbox()).toEqual([]);
  });

  it('refuses a request target that is not plain origin-form, whatever the method', async () => {
    for (const route of ['//v1/inputs', '/v1\\inputs', '/v1/inputs/\\..\\cancel']) {
      for (const method of ['POST', 'GET', 'PUT']) {
        const reply = await call(method, route, method === 'GET' ? {} : { body: '{}' });
        expect(reply.status, method + ' ' + route).toBe(400);
        expect(reply.body).toEqual({ error: 'invalid_target' });
      }
    }
    expect(await outbox()).toEqual([]);
  });

  it('invites the body of an action that passed every check, and only that one', async () => {
    const accepted = await call('POST', '/v1/inputs', { body: JSON.stringify(sendBody()), headers: { expect: '100-continue, x-other' } });
    expect(accepted.continued).toBe(true);
    expect(accepted.status).toBe(202);
    await seed([]);
    const refused = await call('POST', '/v1/inputs', { body: JSON.stringify(sendBody()), headers: { expect: '100-continue', 'content-type': 'text/plain' } });
    expect(refused.continued).toBe(false);
    expect(refused.status).toBe(415);
  });
});
