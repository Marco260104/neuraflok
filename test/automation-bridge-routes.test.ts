import type http from 'node:http';
import { expect, it, vi } from 'vitest';
import {
  handleGoalAcknowledgementRoute,
  handleGoalObjectiveRoute,
  handleGoalOpeningRoute
} from '../backend/domains/automation/bridge-routes.js';

it('leaves unrelated automation routes to their owner', async () => {
  const req = { method: 'POST' } as http.IncomingMessage;
  const support = { readBody: vi.fn(), json: vi.fn(), tooLarge: vi.fn(), goalMode: vi.fn(() => 'goal' as const) };

  expect(await handleGoalOpeningRoute('/goal/ack', req, {} as http.ServerResponse, null, support)).toBe(false);
  expect(support.readBody).not.toHaveBeenCalled();
  expect(support.json).not.toHaveBeenCalled();
});

it('rejects an empty objective before starting a model request', async () => {
  const req = { method: 'POST' } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const support = {
    readBody: vi.fn(async () => ({ text: '  ' })),
    json,
    tooLarge: vi.fn(),
    goalMode: vi.fn(() => 'goal' as const)
  };

  expect(await handleGoalOpeningRoute('/goal/open', req, res, null, support)).toBe(true);
  expect(support.readBody).toHaveBeenCalledOnce();
  expect(json).toHaveBeenCalledWith(res, 400, { error: 'no_objective' }, null);
  expect(support.goalMode).not.toHaveBeenCalled();
});

it('uses the standard oversized-body response', async () => {
  const req = { method: 'POST' } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const tooLarge = vi.fn();
  const support = {
    readBody: vi.fn(async () => { throw new Error('body_too_large'); }),
    json: vi.fn(),
    tooLarge,
    goalMode: vi.fn(() => 'goal' as const)
  };

  expect(await handleGoalOpeningRoute('/goal/open', req, res, 'https://provider.test', support)).toBe(true);
  expect(tooLarge).toHaveBeenCalledWith(res, 'https://provider.test');
  expect(support.json).not.toHaveBeenCalled();
});

it('rejects acknowledgements without a valid conversation identity', async () => {
  const req = { method: 'POST' } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const support = {
    readBody: vi.fn(async () => ({ conversationId: 'invalid' })),
    json,
    tooLarge: vi.fn(),
    conversationId: vi.fn(() => null),
    extendedSilenceWindowFor: vi.fn(async () => false),
    recoveryBusyMs: vi.fn(() => 1000)
  };

  expect(await handleGoalAcknowledgementRoute('/goal/ack', req, res, null, support)).toBe(true);
  expect(json).toHaveBeenCalledWith(res, 400, { error: 'bad_conversation_id' }, null);
  expect(support.extendedSilenceWindowFor).not.toHaveBeenCalled();
});

it('rejects objectives without a valid conversation identity', async () => {
  const req = { method: 'POST' } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const support = {
    readBody: vi.fn(async () => ({ conversationId: 'invalid' })),
    json,
    tooLarge: vi.fn(),
    conversationId: vi.fn(() => null),
    saveObjective: vi.fn(async () => ({}))
  };

  expect(await handleGoalObjectiveRoute('/goal/objective', req, res, null, support)).toBe(true);
  expect(json).toHaveBeenCalledWith(res, 400, { error: 'bad_conversation_id' }, null);
  expect(support.saveObjective).not.toHaveBeenCalled();
});
