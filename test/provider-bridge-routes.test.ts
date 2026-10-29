import type http from 'node:http';
import { expect, it, vi } from 'vitest';
import { handleProviderPageRoute } from '../backend/domains/providers/bridge-routes.js';
import { pendingProviderPage, requestProviderPageComplete, settleProviderPage } from '../backend/domains/providers/provider-page.js';

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

it('serves only the current provider offer attachment in bounded base64 chunks', async () => {
  const conversationId = 'ds-00000000-0000-0000-0000-000000000001';
  const attachmentId = '00000000-0000-4000-8000-000000000001';
  const bytes = Buffer.from('synthetic PDF bytes');
  const pending = requestProviderPageComplete('deepseek', conversationId, 'Summarize the attached file.', undefined, {
    attachments: [{ id: attachmentId, name: 'sample.pdf', mimeType: 'application/pdf', size: bytes.length, bytes }]
  });
  const offer = pendingProviderPage()!;
  const req = { method: 'POST' } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const support = {
    readBody: vi.fn(async () => ({ id: offer.id, provider: 'deepseek', conversationId, attachmentId, offset: 0 })),
    json: vi.fn(),
    tooLarge: vi.fn()
  };

  expect(await handleProviderPageRoute('/provider/page/attachment', req, res, null, true, support)).toBe(true);
  expect(support.json).toHaveBeenCalledWith(res, 200, { chunk: bytes.toString('base64') }, null);
  expect(support.readBody).toHaveBeenCalledOnce();
  expect(settleProviderPage({ id: offer.id, provider: 'deepseek', conversationId, text: 'Uploaded' })).toBe(true);
  await expect(pending).resolves.toEqual({ text: 'Uploaded' });
});

it('pre-uploads attachments without offering or sending chat text and waits for DeepSeek confirmation', async () => {
  const conversationId = 'ds-00000000-0000-0000-0000-000000000002';
  const attachmentId = '00000000-0000-4000-8000-000000000002';
  const bytes = Buffer.from('%PDF-synthetic');
  const pending = requestProviderPageComplete('deepseek', conversationId, '', undefined, {
    fresh: true,
    uploadOnly: true,
    attachments: [{ id: attachmentId, name: 'sample.pdf', mimeType: 'application/pdf', size: bytes.length, bytes }]
  });
  const offer = pendingProviderPage()!;
  expect(offer).toMatchObject({ conversationId, text: '', fresh: true, uploadOnly: true, attachments: [{ id: attachmentId }] });
  expect(settleProviderPage({ id: offer.id, provider: 'deepseek', conversationId, attachmentUploaded: true })).toBe(true);
  await expect(pending).resolves.toEqual({ text: '', attachmentUploaded: true });
});

it('offers a remove-only request and resolves it only after DeepSeek confirms the file card was removed', async () => {
  const conversationId = 'ds-00000000-0000-0000-0000-000000000003';
  const attachmentId = '00000000-0000-4000-8000-000000000003';
  const pending = requestProviderPageComplete('deepseek', conversationId, '', undefined, {
    removeOnly: true,
    attachmentTargets: [{ id: attachmentId, name: 'sample.pdf', mimeType: 'application/pdf', size: 12_800_000 }]
  });
  const offer = pendingProviderPage()!;
  expect(offer).toMatchObject({
    conversationId, text: '', removeOnly: true,
    attachments: [{ id: attachmentId, name: 'sample.pdf', size: 12_800_000 }]
  });
  expect(settleProviderPage({ id: offer.id, provider: 'deepseek', conversationId, attachmentUploaded: true })).toBe(true);
  await expect(pending).rejects.toThrow('The provider page returned no reply.');

  const retry = requestProviderPageComplete('deepseek', conversationId, '', undefined, {
    removeOnly: true,
    attachmentTargets: [{ id: attachmentId, name: 'sample.pdf', mimeType: 'application/pdf', size: 12_800_000 }]
  });
  const retryOffer = pendingProviderPage()!;
  expect(settleProviderPage({ id: retryOffer.id, provider: 'deepseek', conversationId, attachmentRemoved: true })).toBe(true);
  await expect(retry).resolves.toEqual({ text: '', attachmentRemoved: true });
});
