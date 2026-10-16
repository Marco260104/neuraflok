const listeners = new Set<() => void>();

export function onGoalChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyGoalChange(): void {
  for (const listener of listeners) listener();
}