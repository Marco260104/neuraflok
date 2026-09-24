const LEAF_DIRECTIVE = /^[ \t]*::[a-z][\w-]*(?:\{[^}\n]*\})?[ \t]*$/gim;
const CONTAINER_OPEN = /^[ \t]*:::(?!writing\b)[a-z][\w-]*(?:\{[^}\n]*\})?[ \t]*$/gim;
const CONTAINER_CLOSE = /^[ \t]*:::[ \t]*$/gm;

// Remove unsupported provider markers while preserving app-owned writing blocks.
export function cleanProviderReply(text: string): string {
  LEAF_DIRECTIVE.lastIndex = 0;
  const hasLeaf = LEAF_DIRECTIVE.test(text);
  LEAF_DIRECTIVE.lastIndex = 0;
  CONTAINER_OPEN.lastIndex = 0;
  const hasContainer = CONTAINER_OPEN.test(text);
  CONTAINER_OPEN.lastIndex = 0;
  if (!hasLeaf && !hasContainer) return text;

  let cleaned = text.replace(LEAF_DIRECTIVE, '').replace(CONTAINER_OPEN, '');
  if (hasContainer) cleaned = cleaned.replace(CONTAINER_CLOSE, '');
  return cleaned.replace(/\n{3,}/g, '\n\n').trim() || '[This reply contains an unrecorded content reference.]';
}
