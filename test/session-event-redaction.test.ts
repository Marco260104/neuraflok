import { describe, expect, it } from 'vitest';
import { redactArgs, redactResult, safeJson } from '../backend/domains/sessions/history/event-redaction.js';

describe('session event redaction', () => {
  it('leaves primitive arguments unchanged', () => {
    expect(redactArgs('tool', null)).toBeNull();
    expect(redactArgs('tool', 'plain text')).toBe('plain text');
  });

  it('removes credentials and masks environment values without mutating input', () => {
    const args = {
      file: 'https://download.example/private-token',
      env: { API_KEY: 'secret-value', HOME: '/private/home' },
      dataBase64: 'encoded-payload',
      secret: 'session-capability'
    };

    expect(redactArgs('download_artifact', args)).toEqual({
      file: '<native file credentials not stored>',
      env: { API_KEY: '***', HOME: '***' },
      dataBase64: '<15 base64 characters not stored>',
      secret: '<removed>'
    });
    expect(args.env.API_KEY).toBe('secret-value');
  });

  it('keeps clipboard write payloads out of tool arguments', () => {
    expect(redactArgs('write_clipboard', { text: 'private clipboard data' })).toEqual({
      text: '<22 characters not stored>'
    });
  });

  it('redacts clipboard writes inside computer action batches', () => {
    const click = { type: 'click', x: 10, y: 20 };
    expect(redactArgs('computer', {
      actions: [{ type: 'write_clipboard', text: 'private' }, click]
    })).toEqual({
      actions: [{ type: 'write_clipboard', text: '<7 characters not stored>' }, click]
    });
  });

  it('redacts recognizable credentials in other tool results', () => {
    const token = `sk-proj-${'A'.repeat(24)}`;
    expect(redactResult('search', `Found ${token}`)).toBe('Found [redacted]');
  });

  it('never stores the result of a clipboard read', () => {
    expect(redactResult('read_clipboard', 'private clipboard contents')).toBe('<clipboard text not stored>');
  });

  it('hides clipboard lines while preserving other computer output', () => {
    expect(redactResult('computer', 'Clicked button\nClipboard read result: private value\nFinished'))
      .toBe('Clicked button\nClipboard read result: <clipboard text not stored>\nFinished');
  });

  it('serializes ordinary values and returns a safe marker for circular input', () => {
    expect(safeJson({ answer: 42 })).toBe('{"answer":42}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeJson(circular)).toBe('"<arguments could not be serialised>"');
  });
});
