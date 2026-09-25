import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AssetRef,
  ImageStorageClearMode,
  ImageStorageClearResult,
  ImageStorageInfo,
} from "../../../../contracts/session.js";
import { logWarn } from "../../../infrastructure/settings/logger.js";
import type { sessionAssetsRuntime } from "./store.js";
import { createSessionAssetFilesystem, type StoredImageFile } from "./session-asset-filesystem.js";
import { createSessionImageReferenceRetirement } from "./session-image-reference-retirement.js";
import { createSessionAssetReferenceLedger } from "./session-asset-reference-ledger.js";

// Session assets use content-addressed files, bounded quotas, and reference-safe cleanup.
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_SESSION_ASSET_BYTES = 192 * 1024 * 1024;
export const MAX_GLOBAL_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_OVERFLOW_ASSET_CHARS = 8 * 1024 * 1024;

type Runtime = typeof sessionAssetsRuntime;

export function createSessionAssets(runtime: Runtime) {
  const {
    assertReady,
    assertSessionId,
    getRoot,
    sessionDir,
  } = runtime;
  const sessionAssetUsage = new Map<string, number>();
  let globalAssetUsage: number | null = null;
  let assetWriteQueue = Promise.resolve();
  const referenceLedger = createSessionAssetReferenceLedger();
  const {
    admittedAssets,
    deniedAssetIds,
    mergedRetiredAssetIds,
    retainedAssets,
    captureWriteEpoch,
    beginCleanupEpoch,
    markWritten,
    markRemoved,
  } = referenceLedger;
  const assetFilesystem = createSessionAssetFilesystem({ assertReady, getRoot, sessionDir, sessionAssetUsage,
    setGlobalAssetUsage: bytes => { globalAssetUsage = bytes; } });
  const { imageStorageInventory, deleteSelectedImage } = assetFilesystem;
  const { retireSessionImages } = createSessionImageReferenceRetirement(
    runtime,
    retainedAssets,
  );

  function enqueueAssetOperation<T>(operation: () => Promise<T>): Promise<T> {
    const work = assetWriteQueue.then(operation);
    assetWriteQueue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  /** Canonical background launch: the call UUID owns its later process status. */

  // Stores a binary beside the log and returns a reference. Content-addressed, so a screenshot taken twice costs one file. This is the whole reason the log stays readable: a 300 KB PNG never becomes a 400 KB base64 string inside a line that a summary pass then has to skip over.
  async function writeAsset(
    sessionId: string,
    data: Buffer,
    mimeType: string,
  ): Promise<AssetRef> {
    assertSessionId(sessionId);
    if (data.length === 0 || data.length > MAX_ASSET_BYTES)
      throw new Error("Session asset exceeds the per-asset limit");
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 32);
    const extension =
      mimeType === "image/png"
        ? ".png"
        : mimeType === "image/jpeg"
          ? ".jpg"
          : mimeType === "text/plain"
            ? ".txt"
            : ".bin";
    const id = `${hash}${extension}`;
    // Invocation time, rather than queue execution time, decides which side of an explicit cleanup this write belongs to. A write already admitted when cleanup starts may finish, but its late reference cannot resurrect the retired file.
    const admittedAt = captureWriteEpoch();
    return enqueueAssetOperation(async () => {
      const dir = path.join(sessionDir(sessionId), "assets");
      await fs.mkdir(dir, { recursive: true });
      const target = path.join(dir, id);
      try {
        await fs.stat(target);
        markWritten(sessionId, id, admittedAt);
        return { id, mimeType, bytes: data.length };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const used = await sessionAssetBytesOnDisk(sessionId);
      const globalUsed = await globalAssetBytesOnDisk();
      if (used + data.length > MAX_SESSION_ASSET_BYTES)
        throw new Error("Session asset quota exceeded");
      if (globalUsed + data.length > MAX_GLOBAL_ASSET_BYTES)
        throw new Error("Global session asset quota exceeded");
      try {
        await fs.writeFile(target, data, { flag: "wx" });
        sessionAssetUsage.set(sessionId, used + data.length);
        globalAssetUsage = globalUsed + data.length;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      markWritten(sessionId, id, admittedAt);
      return { id, mimeType, bytes: data.length };
    });
  }

  async function directoryFileBytes(dir: string): Promise<number> {
    let total = 0;
    let handle: Awaited<ReturnType<typeof fs.opendir>> | null = null;
    try {
      handle = await fs.opendir(dir);
      for await (const entry of handle) {
        if (!entry.isFile()) continue;
        try {
          total += (await fs.stat(path.join(dir, entry.name))).size;
        } catch {
          // A concurrent delete simply removes it from the durable total.
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return total;
  }

  async function sessionAssetBytesOnDisk(sessionId: string): Promise<number> {
    const cached = sessionAssetUsage.get(sessionId);
    if (cached !== undefined) return cached;
    const used = await directoryFileBytes(
      path.join(sessionDir(sessionId), "assets"),
    );
    sessionAssetUsage.set(sessionId, used);
    return used;
  }

  async function globalAssetBytesOnDisk(): Promise<number> {
    if (globalAssetUsage !== null) return globalAssetUsage;
    let total = 0;
    let handle: Awaited<ReturnType<typeof fs.opendir>> | null = null;
    try {
      handle = await fs.opendir(getRoot());
      for await (const entry of handle) {
        if (!entry.isDirectory() || !/^[0-9a-z-]{8,64}$/i.test(entry.name))
          continue;
        total += await sessionAssetBytesOnDisk(entry.name);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    globalAssetUsage = total;
    return total;
  }

  function getImageStorage(): Promise<ImageStorageInfo> {
    return enqueueAssetOperation(async () => {
      assertReady();
      // Asset writes and cleanup already maintain this quota authority under the same queue.
      const usedBytes =
        globalAssetUsage ?? (await imageStorageInventory(false)).usedBytes;
      return { usedBytes, limitBytes: MAX_GLOBAL_ASSET_BYTES };
    });
  }

  /** Explicit user cleanup. No automatic eviction and no alternate cache can bypass the 2 GiB cap. */
  async function clearImageStorage(
    mode: ImageStorageClearMode,
  ): Promise<ImageStorageClearResult> {
    assertReady();
    // This synchronous edge separates already-admitted writers from writes initiated after the explicit cleanup request, including callers that are still waiting on the asset queue.
    const cleanupEpoch = beginCleanupEpoch();
    let announceSelection!: (files: StoredImageFile[]) => void;
    let rejectSelection!: (error: unknown) => void;
    let finishRetirement!: (files: Set<string>) => void;
    let rejectRetirement!: (error: unknown) => void;
    const selection = new Promise<StoredImageFile[]>((resolve, reject) => {
      announceSelection = resolve;
      rejectSelection = reject;
    });
    const retirement = new Promise<Set<string>>((resolve, reject) => {
      finishRetirement = resolve;
      rejectRetirement = reject;
    });

    // Claim the existing asset queue before inspecting disk. Prior writes finish first; later writes wait until references are retired and selected files are gone.
    const cleanup = enqueueAssetOperation(async () => {
      try {
        const inventory = await imageStorageInventory();
        const ordered = [...inventory.images].sort(
          (left, right) =>
            left.mtimeMs - right.mtimeMs ||
            left.sessionId.localeCompare(right.sessionId) ||
            left.assetId.localeCompare(right.assetId),
        );
        const chosen: StoredImageFile[] = [];
        let chosenBytes = 0;
        for (const file of ordered) {
          if (mode === "oldest-gib" && chosenBytes >= 1024 * 1024 * 1024) break;
          chosen.push(file);
          chosenBytes += file.bytes;
        }
        for (const file of chosen)
          markRemoved(file.sessionId, file.assetId, cleanupEpoch);
        announceSelection(chosen);
        const deletable = await retirement;
        let freedBytes = 0;
        let removedFiles = 0;
        for (const file of chosen) {
          const identity = `${file.sessionId}\u0000${file.assetId}`;
          if (!deletable.has(identity)) continue;
          const removed = await deleteSelectedImage(file);
          if (!removed) continue;
          freedBytes += removed;
          removedFiles += 1;
        }
        sessionAssetUsage.clear();
        globalAssetUsage = null;
        const after = await imageStorageInventory(false);
        return {
          freedBytes,
          removedFiles,
          usedBytes: after.usedBytes,
          limitBytes: MAX_GLOBAL_ASSET_BYTES,
        };
      } catch (error) {
        rejectSelection(error);
        throw error;
      }
    });

    try {
      const chosen = await selection;
      const bySession = new Map<string, Set<string>>();
      for (const file of chosen) {
        const ids = bySession.get(file.sessionId) ?? new Set<string>();
        ids.add(file.assetId);
        bySession.set(file.sessionId, ids);
      }
      const deletable = new Set<string>();
      for (const [sessionId, ids] of bySession) {
        for (const assetId of await retireSessionImages(sessionId, ids))
          deletable.add(`${sessionId}\u0000${assetId}`);
      }
      finishRetirement(deletable);
    } catch (error) {
      rejectRetirement(error);
    }
    return cleanup;
  }

  function invalidateAssetUsage(sessionId: string): void {
    sessionAssetUsage.delete(sessionId);
    globalAssetUsage = null;
  }

  async function readAsset(
    sessionId: string,
    assetId: string,
    maxBytes?: number,
  ): Promise<Buffer | null> {
    assertSessionId(sessionId);
    if (!/^[0-9a-f]{8,64}\.(png|jpg|txt|bin)$/.test(assetId)) return null;
    try {
      const file = path.join(sessionDir(sessionId), "assets", assetId);
      if (maxBytes === undefined) return await fs.readFile(file);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
      const handle = await fs.open(file, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes) return null;
        // One bounded allocation and the same file handle throughout: an extra byte detects growth after stat instead of letting readFile grow the allocation.
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            length,
            buffer.length - length,
            length,
          );
          if (!bytesRead) return buffer.subarray(0, length);
          length += bytesRead;
        }
        return null;
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  // Stores text too long to sit inline, and returns the reference to put in the event. Content-addressed like any other asset, so a command run twice with the same enormous output costs one file. Returns null only when the text is beyond even this — at which point the event says so rather than pretending the record is complete.
  async function writeOverflowText(
    sessionId: string,
    text: string,
  ): Promise<string | null> {
    if (text.length > MAX_OVERFLOW_ASSET_CHARS) return null;
    try {
      const asset = await writeAsset(
        sessionId,
        Buffer.from(text, "utf8"),
        "text/plain",
      );
      return asset.id;
    } catch (err) {
      logWarn(
        `session ${sessionId}: overflow text not stored: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Reads back text spilled by writeOverflowText. */
  async function readOverflowText(
    sessionId: string,
    assetId: string,
  ): Promise<string | null> {
    const data = await readAsset(sessionId, assetId);
    return data ? data.toString("utf8") : null;
  }

  function reset(): void {
    sessionAssetUsage.clear();
    globalAssetUsage = null;
    referenceLedger.reset();
  }

  return {
    admittedAssets,
    deniedAssetIds,
    mergedRetiredAssetIds,
    retainedAssets,
    writeAsset,
    getImageStorage,
    clearImageStorage,
    readAsset,
    writeOverflowText,
    readOverflowText,
    invalidateAssetUsage,
    reset,
  };
}
