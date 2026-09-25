export function longestCommonLineCount(before: readonly string[], after: readonly string[]): number {
  let rows = before;
  let columns = after;
  if (columns.length > rows.length) [rows, columns] = [columns, rows];

  const lengths = new Uint32Array(columns.length + 1);
  for (const line of rows) {
    let diagonal = 0;
    for (let column = 1; column <= columns.length; column++) {
      const above = lengths[column]!;
      if (line === columns[column - 1]) lengths[column] = diagonal + 1;
      else if (lengths[column - 1]! > above) lengths[column] = lengths[column - 1]!;
      diagonal = above;
    }
  }

  return lengths[columns.length] ?? 0;
}
