import type { AssetRef } from "../../../../contracts/session.js";

export function createSessionAssetReferenceLedger() {
  let mutationEpoch = 0;
  const writtenEpoch = new Map<string, number>();
  const removedEpoch = new Map<string, number>();

  function localAssetKey(sessionId: string, assetId: string): string {
    return `${sessionId}\u0000${assetId}`;
  }

  function admittedAssets(
    sessionId: string,
    assets: readonly AssetRef[] | undefined,
  ): AssetRef[] | undefined {
    if (!assets) return undefined;
    const kept = assets.filter((asset) => {
      const key = localAssetKey(sessionId, asset.id);
      const writtenAt = writtenEpoch.get(key);
      const removedAt = removedEpoch.get(key);
      return (
        writtenAt === undefined ||
        removedAt === undefined ||
        writtenAt >= removedAt
      );
    });
    return kept.length ? kept : undefined;
  }

  function deniedAssetIds(
    sessionId: string,
    assets: readonly AssetRef[] | undefined,
  ): string[] {
    if (!assets) return [];
    const admitted = new Set(
      admittedAssets(sessionId, assets)?.map((asset) => asset.id),
    );
    return assets
      .filter((asset) => !admitted.has(asset.id))
      .map((asset) => asset.id);
  }

  function mergedRetiredAssetIds(
    ...groups: Array<readonly string[] | undefined>
  ): string[] | undefined {
    const ids = [...new Set(groups.flatMap((group) => group ?? []))];
    return ids.length ? ids : undefined;
  }

  function retainedAssets(
    assets: readonly AssetRef[] | undefined,
    retired: readonly string[] | undefined,
  ): AssetRef[] | undefined {
    if (!assets) return undefined;
    if (!retired?.length) return [...assets];
    const denied = new Set(retired);
    const kept = assets.filter((asset) => !denied.has(asset.id));
    return kept.length ? kept : undefined;
  }

  function captureWriteEpoch(): number {
    return mutationEpoch;
  }

  function beginCleanupEpoch(): number {
    mutationEpoch += 1;
    return mutationEpoch;
  }

  function markWritten(sessionId: string, assetId: string, epoch: number): void {
    writtenEpoch.set(localAssetKey(sessionId, assetId), epoch);
  }

  function markRemoved(sessionId: string, assetId: string, epoch: number): void {
    removedEpoch.set(localAssetKey(sessionId, assetId), epoch);
  }

  function reset(): void {
    mutationEpoch = 0;
    writtenEpoch.clear();
    removedEpoch.clear();
  }

  return {
    admittedAssets,
    deniedAssetIds,
    mergedRetiredAssetIds,
    retainedAssets,
    captureWriteEpoch,
    beginCleanupEpoch,
    markWritten,
    markRemoved,
    reset,
  };
}
