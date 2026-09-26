import type { AssetRef, SessionEvent } from "../../../../contracts/session.js";
import type { CanonicalEvent, sessionAssetsRuntime } from "./store.js";

type Runtime = Pick<
  typeof sessionAssetsRuntime,
  | "enqueueSessionOperation"
  | "ensureOpen"
  | "messageKey"
  | "readEvents"
  | "scheduleMeta"
  | "writeCanonicalMessage"
>;

type RetainAssets = (
  assets: readonly AssetRef[] | undefined,
  retired: readonly string[] | undefined,
) => AssetRef[] | undefined;

function referencedAssetIds(event: SessionEvent): readonly AssetRef[] {
  if (event.kind === "native_image") return event.asset ? [event.asset] : [];
  if (event.kind === "user_message") return event.assets ?? [];
  if (event.kind === "tool_call") return event.call.assets ?? [];
  return [];
}

function retireImageReferences(
  event: CanonicalEvent,
  selected: ReadonlySet<string>,
  retainedAssets: RetainAssets,
): CanonicalEvent | null {
  if (event.kind === "native_image") {
    if (!event.asset || !selected.has(event.asset.id)) return null;
    const { asset: _asset, ...withoutAsset } = event;
    return {
      ...withoutAsset,
      previewStatus: "unavailable",
      previewError: "removed",
    };
  }
  if (event.kind === "user_message") {
    const removed = (event.assets ?? []).filter((asset) =>
      selected.has(asset.id),
    );
    if (!removed.length) return null;
    const retiredImageAssetIds = [
      ...new Set([
        ...(event.retiredImageAssetIds ?? []),
        ...removed.map((asset) => asset.id),
      ]),
    ];
    return {
      ...event,
      assets: retainedAssets(event.assets, retiredImageAssetIds),
      retiredImageAssetIds,
    };
  }
  if (event.kind !== "tool_call") return null;
  const removed = (event.call.assets ?? []).filter((asset) =>
    selected.has(asset.id),
  );
  if (!removed.length) return null;
  const retiredImageAssetIds = [
    ...new Set([
      ...(event.call.retiredImageAssetIds ?? []),
      ...removed.map((asset) => asset.id),
    ]),
  ];
  return {
    ...event,
    call: {
      ...event.call,
      assets: retainedAssets(event.call.assets, retiredImageAssetIds),
      retiredImageAssetIds,
    },
  };
}

// Persist reference retirement before callers remove image files; unkeyed references veto deletion for the affected asset.
export function createSessionImageReferenceRetirement(
  runtime: Runtime,
  retainedAssets: RetainAssets,
) {
  const {
    enqueueSessionOperation,
    ensureOpen,
    messageKey,
    readEvents,
    scheduleMeta,
    writeCanonicalMessage,
  } = runtime;

  async function retireSessionImages(
    sessionId: string,
    selected: ReadonlySet<string>,
  ): Promise<Set<string>> {
    const events = await readEvents(sessionId);
    const safe = new Set(selected);
    const keyed = new Map<string, CanonicalEvent>();
    for (const event of events) {
      const assets = referencedAssetIds(event);
      if (!assets.some((asset) => selected.has(asset.id))) continue;
      const key = messageKey(event);
      if (
        !key ||
        !["user_message", "native_image", "tool_call"].includes(event.kind)
      ) {
        for (const asset of assets) safe.delete(asset.id);
        continue;
      }
      keyed.set(key, event as CanonicalEvent);
    }
    const entry = await ensureOpen(sessionId);
    await enqueueSessionOperation(entry, "image storage cleanup", async () => {
      for (const [key, observed] of keyed) {
        const current = entry.messages.get(key) ?? observed;
        const retired = retireImageReferences(current, safe, retainedAssets);
        if (!retired) continue;
        const full = {
          ...retired,
          origin: retired.origin ?? retired.seq,
          seq: entry.nextSeq,
        } as CanonicalEvent;
        await writeCanonicalMessage(sessionId, key, full);
        entry.messages.set(key, full);
        entry.nextSeq += 1;
        entry.historySeq = full.seq;
      }
      if (keyed.size) scheduleMeta(entry);
    });
    return safe;
  }

  return { retireSessionImages };
}
