export interface PinnedSourceArchive {
  file: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface NativeSourceInventory {
  componentNoticesSha256: string;
  packages: Record<string, string>;
  sources: PinnedSourceArchive[];
}

export function loadNativeSourceInventory(root: string): Promise<{
  inventory: NativeSourceInventory;
  noticeDirectory: string;
}>;
