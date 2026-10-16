import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

export interface StoredImageFile {
  sessionId: string;
  assetId: string;
  bytes: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

interface VerifiedAssetsDirectory {
  path: string;
  realPath: string;
}

interface VerifiedAssetFile {
  bytes: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  image: boolean;
}

type Runtime = {
  assertReady(): void;
  getRoot(): string;
  sessionDir(sessionId: string): string;
  sessionAssetUsage: Map<string, number>;
  setGlobalAssetUsage(bytes: number | null): void;
};

export function createSessionAssetFilesystem(runtime: Runtime) {
  const { assertReady, getRoot, sessionDir, sessionAssetUsage } = runtime;
  function imageHeader(header: Buffer): boolean {
    return (
      (header.length >= 8 &&
        header
          .subarray(0, 8)
          .equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          )) ||
      (header.length >= 3 &&
        header[0] === 0xff &&
        header[1] === 0xd8 &&
        header[2] === 0xff) ||
      (header.length >= 12 &&
        header.subarray(0, 4).toString("ascii") === "RIFF" &&
        header.subarray(8, 12).toString("ascii") === "WEBP")
    );
  }

  function sameFilesystemPath(left: string, right: string): boolean {
    const normalize = (value: string): string => {
      const resolved = path.resolve(value);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    return normalize(left) === normalize(right);
  }

  async function verifiedAssetsDirectory(
    sessionId: string,
  ): Promise<VerifiedAssetsDirectory | null> {
    const expectedSession = sessionDir(sessionId);
    const expectedAssets = path.join(expectedSession, "assets");
    try {
      const rootStat = await fs.lstat(getRoot());
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
      const rootReal = await fs.realpath(getRoot());
      const sessionStat = await fs.lstat(expectedSession);
      if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink())
        return null;
      const sessionReal = await fs.realpath(expectedSession);
      if (
        !sameFilesystemPath(path.dirname(sessionReal), rootReal) ||
        path.basename(sessionReal) !== sessionId
      )
        return null;
      const assetsStat = await fs.lstat(expectedAssets);
      if (!assetsStat.isDirectory() || assetsStat.isSymbolicLink()) return null;
      const assetsReal = await fs.realpath(expectedAssets);
      if (
        !sameFilesystemPath(path.dirname(assetsReal), sessionReal) ||
        path.basename(assetsReal) !== "assets"
      )
        return null;
      return { path: expectedAssets, realPath: assetsReal };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async function inspectVerifiedAssetFile(
    directory: VerifiedAssetsDirectory,
    name: string,
  ): Promise<VerifiedAssetFile | null> {
    const target = path.join(directory.path, name);
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      const before = await fs.lstat(target);
      if (!before.isFile() || before.isSymbolicLink()) return null;
      const real = await fs.realpath(target);
      if (
        !sameFilesystemPath(path.dirname(real), directory.realPath) ||
        path.basename(real) !== name
      )
        return null;
      handle = await fs.open(
        target,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino)
        return null;
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const image = imageHeader(header.subarray(0, bytesRead));
      const after = await fs.lstat(target);
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.size !== stat.size
      )
        return null;
      return {
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
        image,
      };
    } catch (error) {
      if (
        ["ENOENT", "ELOOP"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return null;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** Exact physical quota inventory. Directory entries, not caller paths, define the scope. */
  async function imageStorageInventory(
    collectImages = true,
  ): Promise<{ usedBytes: number; images: StoredImageFile[] }> {
    assertReady();
    let usedBytes = 0;
    const images: StoredImageFile[] = [];
    const usage = new Map<string, number>();
    let sessions: Awaited<ReturnType<typeof fs.opendir>> | null = null;
    try {
      const rootStat = await fs.lstat(getRoot());
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        sessionAssetUsage.clear();
        runtime.setGlobalAssetUsage(0);
        return { usedBytes: 0, images: [] };
      }
      sessions = await fs.opendir(getRoot());
      for await (const session of sessions) {
        if (!session.isDirectory() || !/^[0-9a-z-]{8,64}$/i.test(session.name))
          continue;
        const assetsDir = await verifiedAssetsDirectory(session.name);
        if (!assetsDir) continue;
        let entries: Awaited<ReturnType<typeof fs.opendir>> | null = null;
        let sessionBytes = 0;
        try {
          entries = await fs.opendir(assetsDir.path);
          for await (const entry of entries) {
            // Symlinks and other special files neither consume the app's quota nor become cleanup targets.
            if (
              !entry.isFile() ||
              !/^[0-9a-f]{8,64}\.(?:bin|png|jpg|txt)$/i.test(entry.name)
            )
              continue;
            // Usage needs metadata only. Opening every file to classify its contents belongs to confirmed cleanup, not to displaying the quota (including a cold start).
            if (!collectImages) {
              try {
                const stat = await fs.lstat(
                  path.join(assetsDir.path, entry.name),
                );
                if (stat.isFile() && !stat.isSymbolicLink())
                  sessionBytes += stat.size;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                  throw error;
              }
              continue;
            }
            const file = await inspectVerifiedAssetFile(assetsDir, entry.name);
            if (!file) continue;
            sessionBytes += file.bytes;
            if (file.image) {
              const { image: _image, ...stored } = file;
              images.push({
                sessionId: session.name,
                assetId: entry.name,
                ...stored,
              });
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        } finally {
          await entries?.close().catch(() => undefined);
        }
        usage.set(session.name, sessionBytes);
        usedBytes += sessionBytes;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await sessions?.close().catch(() => undefined);
    }
    sessionAssetUsage.clear();
    for (const [sessionId, bytes] of usage)
      sessionAssetUsage.set(sessionId, bytes);
    runtime.setGlobalAssetUsage(usedBytes);
    return { usedBytes, images };
  }

  function sameStoredImage(
    file: StoredImageFile,
    observed: VerifiedAssetFile,
  ): boolean {
    return (
      observed.image &&
      observed.dev === file.dev &&
      observed.ino === file.ino &&
      observed.bytes === file.bytes
    );
  }

  // Atomically moves the selected directory entry aside, then verifies the moved object before unlinking it. A path replacement can therefore make cleanup abstain, but cannot make it delete the replacement. The app's asset queue excludes legitimate writers throughout.
  async function deleteSelectedImage(file: StoredImageFile): Promise<number> {
    const directory = await verifiedAssetsDirectory(file.sessionId);
    if (!directory) return 0;
    const observed = await inspectVerifiedAssetFile(directory, file.assetId);
    if (!observed || !sameStoredImage(file, observed)) return 0;
    const currentDirectory = await verifiedAssetsDirectory(file.sessionId);
    if (
      !currentDirectory ||
      !sameFilesystemPath(currentDirectory.realPath, directory.realPath)
    )
      return 0;
    const target = path.join(currentDirectory.path, file.assetId);
    const quarantineName = `.cleanup-${process.pid}-${randomUUID()}.tmp`;
    const quarantine = path.join(currentDirectory.path, quarantineName);
    try {
      await fs.rename(target, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    try {
      const movedDirectory = await verifiedAssetsDirectory(file.sessionId);
      if (
        !movedDirectory ||
        !sameFilesystemPath(movedDirectory.realPath, currentDirectory.realPath)
      )
        return 0;
      const moved = await inspectVerifiedAssetFile(
        movedDirectory,
        quarantineName,
      );
      if (!moved || !sameStoredImage(file, moved)) return 0;
      await fs.unlink(quarantine);
      return moved.bytes;
    } finally {
      // A replacement is never deleted. Restore the selected directory entry when possible; otherwise leave the quarantined file as forensic evidence outside future inventories.
      try {
        await fs.lstat(quarantine);
        try {
          await fs.lstat(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            await fs.rename(quarantine, target);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  return { imageStorageInventory, deleteSelectedImage };
}
