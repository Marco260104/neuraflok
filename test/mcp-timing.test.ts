import { afterEach, expect, it, vi } from 'vitest';
import { beginToolExecutionTiming, createToolRequestTiming, currentToolRequestId, runInToolRequestScope } from '../backend/infrastructure/tool-gateway/request-context.js';
import { formatToolRequestTiming } from './support/mcp-http-helpers.js';

afterEach(() => vi.restoreAllMocks());

it('separates local ingress, dispatch phases, and HTTP completion without retaining identities', async () => {
  let now = 10;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const timing = createToolRequestTiming();
  now = 20;
  await runInToolRequestScope({ requestId: 'private-request', timing }, async () => {
    const mark = beginToolExecutionTiming();
    expect(currentToolRequestId()).toBe('private-request');
    now = 23; mark('identity');
    await Promise.resolve();
    now = 38; mark('handler');
    now = 45; mark('delivery');
    now = 65; mark('recorder', true);
  });
  now = 70;
  expect(formatToolRequestTiming(timing)).toBe(' calls=1 ingress_ms=10 identity_ms=3 handler_ms=15 delivery_ms=7 recorder_ms=20 response_tail_ms=5');
  expect(JSON.stringify(timing)).not.toContain('private-request');
  expect(currentToolRequestId()).toBeNull();
});

it('overlapping HTTP contexts keep independent timing and request identity', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const a = createToolRequestTiming();
  const b = createToolRequestTiming();
  const slow = runInToolRequestScope({ requestId: 'a', timing: a }, async () => {
    const mark = beginToolExecutionTiming();
    await wait;
    expect(currentToolRequestId()).toBe('a');
    mark('identity', true);
  });
  now = 4;
  runInToolRequestScope({ requestId: 'b', timing: b }, () => {
    const mark = beginToolExecutionTiming();
    now = 7; mark('handler', true);
  });
  now = 25; release(); await slow;
  expect(a.phases.identity).toBe(25);
  expect(a.phases.handler).toBe(0);
  expect(b.phases.handler).toBe(3);
  expect(b.phases.identity).toBe(0);
  expect(formatToolRequestTiming(createToolRequestTiming())).toBe('');
});
