import { t } from '../../../shared/i18n.js';

interface JsonObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textFromContentBlock(block: unknown): string | null {
  if (!isObject(block)) return null;
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  if (block.type !== 'resource' || !isObject(block.resource)) return null;
  return typeof block.resource.text === 'string' ? block.resource.text : null;
}

function visibleContent(value: JsonObject): string | null {
  if (!Array.isArray(value.content)) return null;
  const text = value.content.flatMap((block) => {
    const part = textFromContentBlock(block);
    return part === null ? [] : [part];
  });
  if (text.length > 0) return text.join('\n\n');
  if (value.structuredContent !== undefined) return JSON.stringify(value.structuredContent, null, 2);
  return null;
}

export function toolResultText(serialized: string, truncated: boolean, hasImages: boolean): string {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (isObject(parsed)) {
      const content = visibleContent(parsed);
      if (content !== null) return content;
      if (Array.isArray(parsed.content) && hasImages) return '';
    }
  } catch {
    if (!hasImages || !truncated) return serialized;
  }
  if (hasImages && truncated) return t('Image result. Full response retained in the recording.');
  return serialized;
}
