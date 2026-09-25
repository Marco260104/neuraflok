export interface ChangedLineSequences {
  before: string[];
  after: string[];
}

export function splitLineSequence(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function removeSharedEdges(before: readonly string[], after: readonly string[]): ChangedLineSequences {
  let head = 0;
  const sharedLimit = Math.min(before.length, after.length);
  while (head < sharedLimit && before[head] === after[head]) head++;

  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - tail - 1] === after[after.length - tail - 1]
  ) {
    tail++;
  }

  return {
    before: before.slice(head, before.length - tail),
    after: after.slice(head, after.length - tail)
  };
}
