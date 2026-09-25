import sharp from 'sharp';
import type { AssetRef } from '../../../../contracts/session.js';
import type { ChatObservation } from './recorder-observations.js';
import { logWarn } from '../../../infrastructure/settings/logger.js';
import { MAX_ASSET_BYTES, upsertNativeImageEvent, writeAsset } from './store.js';

export async function storeImage(sessionId: string, base64: string, mimeType: string): Promise<AssetRef> {
  const data = Buffer.from(base64, 'base64');
  if (data.length === 0 || data.length > MAX_ASSET_BYTES) throw new Error('Session image exceeds the recording limit');
  return writeAsset(sessionId, data, mimeType);
}

export async function recordNativeImage(
  sessionId: string,
  item: ChatObservation,
  base: { time: number; source: 'extension'; turnId?: string; agent?: string }
): Promise<number> {
  if (!item.messageId || !item.providerAssetId || !item.providerRole) return 0;
  const metadata = await upsertNativeImageEvent(sessionId, {
    ...base,
    kind: 'native_image',
    messageId: item.messageId,
    providerAssetId: item.providerAssetId,
    providerRole: item.providerRole,
    ...(item.providerChannel ? { providerChannel: item.providerChannel } : {}),
    ...(item.providerStatus ? { providerStatus: item.providerStatus } : {}),
    ...(item.width ? { width: item.width } : {}),
    ...(item.height ? { height: item.height } : {}),
    previewStatus: item.previewDataUrl ? 'pending' : item.previewStatus ?? 'pending',
    ...(item.previewError ? { previewError: item.previewError } : {})
  });
  // A false `changed` can mean either an idempotent same-owner replay or an explicit role/agent refusal. Only the store's canonical-owner verdict may admit preview bytes.
  if (!metadata.accepted) return 0;
  let changed = metadata.changed ? 1 : 0;
  if (!item.previewDataUrl || metadata.event.asset) return changed;
  try {
    if (!/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(item.previewDataUrl) || item.previewDataUrl.length > 512_100) {
      throw new Error('invalid native image preview');
    }
    const data = Buffer.from(item.previewDataUrl.slice(item.previewDataUrl.indexOf(',') + 1), 'base64');
    if (data.length === 0 || data.length > 384_000) throw new Error('invalid native image preview');
    const decoded = sharp(data, { limitInputPixels: 2_560_000, animated: false });
    const info = await decoded.metadata();
    if (info.format !== 'webp' || !info.width || !info.height || info.width > 1600 || info.height > 1600 ||
        info.width * info.height > 2_560_000 || info.width !== item.previewWidth || info.height !== item.previewHeight) {
      throw new Error('invalid native image preview');
    }
    await decoded.stats();
    const asset = await writeAsset(sessionId, data, 'image/webp');
    const enriched = await upsertNativeImageEvent(sessionId, {
      ...base,
      kind: 'native_image',
      messageId: item.messageId,
      providerAssetId: item.providerAssetId,
      providerRole: item.providerRole,
      ...(item.providerChannel ? { providerChannel: item.providerChannel } : {}),
      ...(item.providerStatus ? { providerStatus: item.providerStatus } : {}),
      ...(item.width ? { width: item.width } : {}),
      ...(item.height ? { height: item.height } : {}),
      previewStatus: 'available',
      previewWidth: info.width,
      previewHeight: info.height,
      asset
    });
    if (enriched.changed) changed += 1;
  } catch (error) {
    const reason = /quota/i.test((error as Error).message) ? 'quota' : 'invalid';
    logWarn(`native generated image preview unavailable: ${(error as Error).message}`);
    const unavailable = await upsertNativeImageEvent(sessionId, {
      ...base,
      kind: 'native_image',
      messageId: item.messageId,
      providerAssetId: item.providerAssetId,
      providerRole: item.providerRole,
      ...(item.providerChannel ? { providerChannel: item.providerChannel } : {}),
      ...(item.providerStatus ? { providerStatus: item.providerStatus } : {}),
      ...(item.width ? { width: item.width } : {}),
      ...(item.height ? { height: item.height } : {}),
      previewStatus: 'unavailable',
      previewError: reason
    });
    if (unavailable.changed) changed += 1;
  }
  return changed;
}
