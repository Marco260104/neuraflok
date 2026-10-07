import type { NativeSourceInventory } from './source-inventory.mjs';

export function createNativeSourceArchive(
  root: string,
  noticeDirectory: string,
  inventory: NativeSourceInventory
): Promise<string>;
