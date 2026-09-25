export function boundedInsertDeleteDistance(before: readonly string[], after: readonly string[], limit: number): number | null {
  let priorFrontier = new Map<number, number>([[1, 0]]);

  for (let depth = 0; depth <= limit; depth++) {
    const frontier = new Map<number, number>();
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const fromDeletion = priorFrontier.get(diagonal - 1);
      const fromInsertion = priorFrontier.get(diagonal + 1);
      const takeInsertion = diagonal === -depth ||
        (diagonal !== depth && (fromDeletion ?? -1) < (fromInsertion ?? -1));
      let x = takeInsertion ? fromInsertion ?? 0 : (fromDeletion ?? 0) + 1;
      let y = x - diagonal;

      while (x >= 0 && y >= 0 && x < before.length && y < after.length && before[x] === after[y]) {
        x++;
        y++;
      }

      frontier.set(diagonal, x);
      if (x >= before.length && y >= after.length) return depth;
    }
    priorFrontier = frontier;
  }

  return null;
}
