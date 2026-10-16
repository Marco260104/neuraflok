import { describe, expect, it } from 'vitest';
import { continuationMarkerOf, unescapeMarkdown } from '../contracts/session.js';

const token = '_0123456789abc-def';
const marker = `[[NEURAFLOK-RESUME:${token}]]`;
const legacyMarker = `[[CLF-RESUME:${token}]]`;

describe('continuation markers in stored messages', () => {
  it.each([
    marker,
    marker.replace(':', '\\:'),
    marker.replace('_', '\\_'),
    marker.replace(/([\[\]:_-])/g, '\\$1'),
    `\n${marker.replace(':', '\\:')}`
  ])('reads a valid marker and preserves the remaining prompt text', value => {
    const text = `${value}\n\nKeep C:\\_work and the rest of the brief unchanged.`;
    const parsed = continuationMarkerOf(text);

    expect(parsed).toMatchObject({ kind: 'RESUME', token, marker: `${value}\n` });
    expect(text.slice(parsed!.marker.length)).toBe('\nKeep C:\\_work and the rest of the brief unchanged.');
  });

  it('reads the previous continuation prefix for stored sessions', () => {
    const text = `${legacyMarker}\n\nResume this saved session.`;
    const parsed = continuationMarkerOf(text);
    expect(parsed).toMatchObject({ kind: 'RESUME', token, marker: `${legacyMarker}\n` });
    expect(text.slice(parsed!.marker.length)).toBe('\nResume this saved session.');
  });

  it.each([
    marker.replace('0', '\\0'),
    marker.replace('a', '\\a'),
    marker.replace('_', '\\\\_'),
    `prefix ${marker}`,
    `[[CLF-RESUME:${'a'.repeat(15)}]]`,
    `[[CLF-RESUME:${'a'.repeat(65)}]]`,
    `${marker}extra`,
    marker.replace('_', 'é')
  ])('rejects malformed markers: %s', value => {
    expect(continuationMarkerOf(value)).toBeNull();
  });
});

describe('stored message unescaping', () => {
  it.each([
    ['[[NEURAFLOK_CONTEXT:34]]\\\nYou are worker-1.\\\nRun it.', '[[NEURAFLOK_CONTEXT:34]]\nYou are worker-1.\nRun it.'],
    ['a\\\r\nb', 'a\nb'],
    ['Keep C:\\_work and \\* unchanged', 'Keep C:_work and * unchanged'],
    ['no escapes here', 'no escapes here'],
    ['&#x20;Indented\n&#x20; deeper\nkeep &#x20; here', ' Indented\n  deeper\nkeep &#x20; here']
  ])('normalizes %j to %j', (raw, expected) => {
    expect(unescapeMarkdown(raw)).toBe(expected);
  });
});
