/** Avoid reusing renderer assets cached by an earlier development branch. */
export function freshDevelopmentRendererUrl(rendererUrl: string, cacheKey = Date.now()): string {
  const url = new URL(rendererUrl);
  url.searchParams.set('nf-renderer-boot', String(cacheKey));
  return url.toString();
}

export async function loadFreshDevelopmentRenderer<T>(
  clearCache: () => Promise<unknown>,
  loadRenderer: () => Promise<T>
): Promise<T> {
  try {
    await clearCache();
  } catch {
    // A cache that cannot be cleared must not prevent the app from opening.
  }
  return loadRenderer();
}
