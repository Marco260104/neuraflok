import { describe, expect, it } from 'vitest';
import { currentToolRequestId, runInToolRequestScope } from '../backend/infrastructure/tool-gateway/request-context.js';
import { requestIdFromHeader } from './support/mcp-http-helpers.js';

describe('MCP inbound request id boundary', () => {
  it('normalizes the raw x-request-id to the page join key once at ingress', () => {
    expect(requestIdFromHeader('wfr_00000000000000000000000000000001/yqy1')).toBe(
      'wfr_00000000000000000000000000000001'
    );
    expect(requestIdFromHeader('  wfr_abc_123/relay-hop')).toBe('wfr_abc_123');
    expect(requestIdFromHeader(['wfr_only/a'])).toBe('wfr_only');
    expect(requestIdFromHeader(['wfr_first/a', 'wfr_second/b'])).toBeNull();

    expect(requestIdFromHeader('/missing-base')).toBeNull();
    expect(requestIdFromHeader('wfr.bad/suffix')).toBeNull();
    expect(requestIdFromHeader('x'.repeat(101))).toBeNull();
    expect(requestIdFromHeader(undefined)).toBeNull();
  });

  it('keeps normalized ids isolated across concurrent async requests', async () => {
    const seen = await Promise.all([
      runInToolRequestScope({ requestId: 'wfr_a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return currentToolRequestId();
      }),
      runInToolRequestScope({ requestId: 'wfr_b' }, async () => {
        await Promise.resolve();
        return currentToolRequestId();
      })
    ]);

    expect(seen).toEqual(['wfr_a', 'wfr_b']);
    expect(currentToolRequestId()).toBeNull();
  });
});
