const previousPrefix = 'neuraljam.';
const currentPrefix = 'neuraflok.';

export function migrateLegacyPreferenceNamespace(storage: Storage): void {
  const legacyKeys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(previousPrefix)) legacyKeys.push(key);
    }
  } catch {
    return;
  }

  for (const legacyKey of legacyKeys) {
    try {
      const value = storage.getItem(legacyKey);
      if (value === null) continue;
      const currentKey = `${currentPrefix}${legacyKey.slice(previousPrefix.length)}`;
      if (storage.getItem(currentKey) === null) storage.setItem(currentKey, value);
      storage.removeItem(legacyKey);
    } catch {
      continue;
    }
  }
}
