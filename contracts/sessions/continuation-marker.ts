export type ContinuationKind = 'HANDOFF' | 'RESUME';

// New markers use the product namespace; the previous prefix remains readable for saved sessions.
export const CONTINUATION_MARKER = /^\s*\[\[(?:NEURAFLOK|CLF)-(HANDOFF|RESUME):([A-Za-z0-9_-]{16,64})\]\](?:\s|$)/;

const ESCAPED_MARKER = /^\s*(?:\\?\[){2}(?:NEURAFLOK|CLF)\\?-(HANDOFF|RESUME)\\?:((?:[A-Za-z0-9]|\\?[_-]){16,64})(?:\\?\]){2}\\?(?:\s|$)/;
const MESSAGE_IDENTITY = /^\[\[(?:NEURAFLOK|CLF)-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n/;

export function formatContinuationMarker(kind: ContinuationKind, token: string): string {
  return token ? `[[NEURAFLOK-${kind}:${token}]]` : '';
}

export function continuationIdentityPrefix(text: string): string {
  return MESSAGE_IDENTITY.exec(text)?.[0] ?? '';
}

export function continuationMarkerOf(text: string | null | undefined): { kind: ContinuationKind; token: string; marker: string } | null {
  const value = typeof text === 'string' ? text : '';
  const match = CONTINUATION_MARKER.exec(value) ?? ESCAPED_MARKER.exec(value.slice(0, 200));
  if (!match) return null;
  return { kind: match[1] as ContinuationKind, token: match[2]!.replace(/\\/g, ''), marker: match[0] };
}
