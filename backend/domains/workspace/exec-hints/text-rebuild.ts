/** Splits on `seps`, maps each part, and joins it back with the separators it was cut on. */
export function rebuild(text: string, seps: readonly string[], map: (part: string) => string): string {
  const pieces: string[] = [];
  const separators: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '{') depth++;
    else if (char === ')' || char === '}') depth = Math.max(0, depth - 1);

    if (depth === 0) {
      const hit = seps.find((sep) => text.startsWith(sep, i));
      if (hit !== undefined) {
        pieces.push(current);
        separators.push(hit);
        current = '';
        i += hit.length - 1;
        continue;
      }
    }
    current += char;
  }
  pieces.push(current);

  return pieces.map(map).reduce((acc, part, index) => acc + (index === 0 ? '' : separators[index - 1]) + part, '');
}

