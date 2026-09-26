import { ComputerError } from './errors.js';

export function localActionFailure(err: unknown, completedCount: number, failedIndex: number): ComputerError {
  const message = err instanceof Error ? err.message : String(err);
  return new ComputerError(
    `PARTIAL_BATCH: completed_count=${completedCount} failed_index=${failedIndex}. ${message}`,
    { completedCount, failedIndex }
  );
}

export async function electronClipboard(): Promise<Pick<Electron.Clipboard, 'readText' | 'writeText'>> {
  try {
    const { clipboard } = await import('electron');
    if (!clipboard) throw new Error('no clipboard');
    return clipboard;
  } catch {
    throw new ComputerError('The clipboard is only available while the app is running.');
  }
}
