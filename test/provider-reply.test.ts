import { describe, expect, it } from 'vitest';
import { cleanProviderReply } from '../contracts/messaging/provider-reply.js';

describe('provider reply cleanup', () => {
  it('removes unsupported markers without dropping surrounding prose', () => {
    const pointer = '::provider-reference{index="0" source_message_id="message-1"}';
    expect(cleanProviderReply(`Before\n${pointer}\nAfter`)).toBe('Before\n\nAfter');
    expect(cleanProviderReply(pointer)).toBe('[This reply contains an unrecorded content reference.]');
  });

  it('keeps container content and application writing blocks', () => {
    const container = ':::canvas{title="Plan"}\nStep one\nStep two\n:::';
    const writing = ':::writing{variant="standard" title="Plan"}\nKeep this text.\n:::';
    expect(cleanProviderReply(container)).toBe('Step one\nStep two');
    expect(cleanProviderReply(writing)).toBe(writing);
  });

  it('leaves ordinary text and inline examples unchanged', () => {
    const text = 'Use `::provider-reference{index="0"}` only as an example.';
    expect(cleanProviderReply(text)).toBe(text);
  });
});
