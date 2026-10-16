export function pageToolKey(id: string): string {
  const match = /^thought-(.+)-0$/.exec(id);
  return match ? match[1]! : id;
}
