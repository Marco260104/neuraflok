type LanguageListener = () => void;

const listeners = new Set<LanguageListener>();

export function onLanguageChange(listener: LanguageListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishLanguageChange(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      continue;
    }
  }
}
