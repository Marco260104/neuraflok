export function formatDelta(delta: { added: number; removed: number }): string | null {
  const parts: string[] = [];
  if (delta.added > 0) parts.push(`+${delta.added}`);
  if (delta.removed > 0) parts.push(`−${delta.removed}`);
  return parts.length === 0 ? null : parts.join(' ');
}
