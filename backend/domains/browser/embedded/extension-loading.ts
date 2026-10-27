/** Clear a stale extension worker before Electron loads the current files from disk. */
export async function loadFreshIntegratedExtension<T>(
  clearServiceWorkers: () => Promise<unknown>,
  loadExtension: () => Promise<T>
): Promise<T> {
  try {
    await clearServiceWorkers();
  } catch {
    // A session without cached service workers must still be able to start.
  }
  return loadExtension();
}
