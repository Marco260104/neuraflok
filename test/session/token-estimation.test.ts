import {
  estimateTokens,
  eventTokens,
  tokenPressure,
} from './context.js';
import type {
  SessionEvent,
} from './context.js';
import { describe, expect, it } from 'vitest';

// ------------------------------------------------------------------ tokens

describe('token estimation', () => {
  it('is an explicit approximation of local text only', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(4001))).toBe(1001);
  });

  it('weighs an event by the text actually kept', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'c1',
        tool: 'read_file',
        attribution: 'turn',
        args: { text: 'a'.repeat(400), truncated: false, chars: 400 },
        result: { text: 'b'.repeat(800), truncated: false, chars: 800 },
        outcome: 'ok',
        durationMs: 3,
        summary: { title: 'Read a.ts', tone: 'neutral', kind: 'read' }
      }
    } as SessionEvent;
    expect(eventTokens(event)).toBe(100 + 200 + Math.ceil('Read a.ts'.length / 4));
  });

  it('caps a truncated tool return independently of its preview and asset reference', () => {
    const event = { seq: 1, time: 1, source: 'mcp', kind: 'tool_call', call: {
      callId: 'full-result', tool: 'read', attribution: 'turn',
      args: { text: 'short preview with a recorder annotation', truncated: true, chars: 20001, assetId: 'args.txt' },
      result: { text: 'x'.repeat(8000) + ' [52306 characters stored as result.txt]', truncated: true, chars: 60306, assetId: 'result.txt' },
      outcome: 'ok', durationMs: 1, summary: { title: 'Read 3 paths', tone: 'neutral', kind: 'read' },
      assets: [{ id: 'result.txt', mimeType: 'text/plain', bytes: 60306 }]
    } } as SessionEvent;
    expect(eventTokens(event)).toBe(Math.ceil(20001 / 4) + 10000 + estimateTokens('Read 3 paths'));
    if (event.kind !== 'tool_call') throw new Error('fixture');
    delete event.call.result.assetId;
    event.call.result.text = 'Another bounded preview; overflow asset unavailable';
    expect(eventTokens(event)).toBe(Math.ceil(20001 / 4) + 10000 + estimateTokens('Read 3 paths'));
  });

  it.each([0, 39996, 40000, 40004, 524582])('caps inline MCP returns at the boundary (%i characters)', chars => {
    const event = { seq: 1, time: 1, source: 'mcp', kind: 'tool_call', call: {
      args: { text: 'a'.repeat(80000), truncated: false, chars: 80000 },
      result: { text: 'r'.repeat(chars), truncated: false, chars }, summary: { title: '' }
    } } as SessionEvent;
    expect(eventTokens(event)).toBe(20000 + Math.min(10000, Math.ceil(chars / 4)));
  });

  it.each([undefined, -1, NaN, Infinity, 2.5])('keeps legacy or malformed original lengths bounded by actual inline text (%s)', chars => {
    const event = { seq: 1, time: 1, source: 'extension', kind: 'user_message',
      message: { text: 'abcdefgh', truncated: true, chars } } as SessionEvent;
    expect(eventTokens(event)).toBe(2);
  });

  it('does not inflate the context advisory with transient progress captions', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'extension',
      kind: 'progress',
      message: { text: 'reasoning status '.repeat(100), truncated: false, chars: 1700 }
    } as SessionEvent;
    expect(eventTokens(event)).toBe(0);
  });

  it('counts a brokered agent message, which the model does read', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'app',
      kind: 'agent_message',
      messageId: 'm1',
      from: 'worker-1',
      to: 'prime',
      message: { text: 'r'.repeat(1200), truncated: false, chars: 1200 },
      delivery: 'delivered'
    } as SessionEvent;
    expect(eventTokens(event)).toBe(300);
  });

  it('grades pressure against the configured thresholds', () => {
    expect(tokenPressure(50_000, 180_000, 200_000).level).toBe('ok');
    expect(tokenPressure(185_000, 180_000, 200_000).level).toBe('large');
    expect(tokenPressure(220_000, 180_000, 200_000).level).toBe('huge');
  });
});
