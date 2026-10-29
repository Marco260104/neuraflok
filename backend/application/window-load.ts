/** Avoid reusing renderer assets cached by an earlier development branch. */
export function freshDevelopmentRendererUrl(rendererUrl: string, cacheKey = Date.now()): string {
  const url = new URL(rendererUrl);
  url.searchParams.set('nf-renderer-boot', String(cacheKey));
  return url.toString();
}

export async function loadFreshDevelopmentRenderer<T>(
  clearStaleWorkers: () => Promise<unknown>,
  clearCache: () => Promise<unknown>,
  loadRenderer: () => Promise<T>
): Promise<T> {
  for (const clear of [clearStaleWorkers, clearCache]) {
    try {
      await clear();
    } catch {
      // A stale renderer cache must not prevent the app from opening.
    }
  }
  return loadRenderer();
}
