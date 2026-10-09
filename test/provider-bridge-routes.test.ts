import type http from 'node:http';
import { expect, it, vi } from 'vitest';
import { handleProviderPageRoute } from '../backend/domains/providers/bridge-routes.js';

it('does not expose the retired account model catalog route', async () => {
  const req = { method: 'POST' } as http.IncomingMessage;
  const support = { readBody: vi.fn(), json: vi.fn(), tooLarge: vi.fn() };

  expect(await handleProviderPageRoute('/models', req, {} as http.ServerResponse, null, true, support)).toBe(false);
  expect(support.readBody).not.toHaveBeenCalled();
  expect(support.json).not.toHaveBeenCalled();
});

it('handles provider page receipts only for the integrated browser host', async () => {
  const req = { method: 'POST' } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const origin = 'chrome-extension://neuraflok';
  const support = {
    readBody: vi.fn(async () => ({ id: 'unknown-operation' })),
    json: vi.fn(),
    tooLarge: vi.fn()
  };

  expect(await handleProviderPageRoute('/provider/page', req, res, origin, true, support)).toBe(true);
  expect(support.readBody).toHaveBeenCalledOnce();
  expect(support.json).toHaveBeenCalledWith(res, 200, { ok: false }, origin);
});
