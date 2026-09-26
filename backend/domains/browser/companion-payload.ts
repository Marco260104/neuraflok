import { isReasoningEffort } from '../../../contracts/session.js';
import { isWebProviderConversationId } from '../../../contracts/web-providers.js';
import { messageReaction } from '../../../contracts/chat/reaction-content.js';
import type { ChatObservation, PageCallEvidence } from '../sessions/history/recorder.js';
// Accept namespaced provider IDs and legacy UUIDs reported by the companion.
export function conversationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return isWebProviderConversationId(value) || /^[0-9a-f-]{8,64}$/i.test(value) ? value : null;
}

const OBSERVATION_KINDS = new Set([
  'model_selection',
  'conversation_title',
  'user_message',
  'assistant_message',
  'native_image',
  'page_tool',
  'turn_start',
  'turn_end',
  'chat_error',
  'tool_evidence'
]);
const OUTCOMES = new Set(['completed', 'failed', 'stopped', 'interrupted', 'stalled', 'unknown']);
const MAX_OBSERVATIONS = 200;

const MAX_CALL_EVIDENCE = 200;

const TOOL_NAME = /^[a-z0-9_.-]{1,64}$/i;

// Validate bounded request ownership evidence from the companion.
export function parseCallEvidence(input: unknown, untooled = false): PageCallEvidence[] {
  if (!Array.isArray(input)) return [];
  const out: PageCallEvidence[] = [];
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const raw of input.slice(0, MAX_CALL_EVIDENCE)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const tool = typeof item['tool'] === 'string' && TOOL_NAME.test(item['tool']) ? item['tool'] : '';
    const requestId =
      typeof item['requestId'] === 'string' && /^[a-z0-9_-]{1,100}$/i.test(item['requestId']) ? item['requestId'] : null;
    const pageMessageId = typeof item['messageId'] === 'string' ? item['messageId'].slice(0, 120) : '';
    const bare = untooled && requestId !== null;
    if (!tool && !bare) continue;
    const stream = bare && !pageMessageId;
    const messageId = stream ? `stream:${requestId}` : pageMessageId;
    if (!messageId) continue;
    if (seen.has(messageId)) {
      if (!stream) duplicated.add(messageId);
      continue;
    }
    seen.add(messageId);
    out.push({
      messageId,
      tool,
      order: typeof item['order'] === 'number' && Number.isFinite(item['order'])
        ? Math.max(0, Math.min(MAX_CALL_EVIDENCE, Math.floor(item['order'])))
        : out.length,
      answered: item['answered'] === true,
      requestId,
      createTime:
        typeof item['createTime'] === 'number' && Number.isFinite(item['createTime']) ? item['createTime'] : null
    });
  }
  return out.filter((call) => !duplicated.has(call.messageId));
}

// Rebuild bounded observations from the untrusted companion payload.
export function parseObservations(input: unknown): ChatObservation[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  const earliestSupportedProviderTime = Date.UTC(2022, 10, 30);
  const out: ChatObservation[] = [];
  for (const raw of input.slice(0, MAX_OBSERVATIONS)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const kind = typeof item['kind'] === 'string' ? item['kind'] : '';
    if (!OBSERVATION_KINDS.has(kind)) continue;
    const time = typeof item['time'] === 'number' && Number.isFinite(item['time']) ? item['time'] : now;
    const observation: ChatObservation = {
      kind: kind as ChatObservation['kind'],
      time: time > now + 60_000 || time < earliestSupportedProviderTime ? now : time
    };
    if (item['authoredTime'] === true) observation.authoredTime = true;
    if ((kind === 'assistant_message' || kind === 'user_message') && typeof item['authoredAt'] === 'number' &&
        Number.isFinite(item['authoredAt']) && item['authoredAt'] >= earliestSupportedProviderTime && item['authoredAt'] <= now + 60_000) {
      observation.authoredAt = item['authoredAt'];
    }
    if (item['authoredNow'] === true && kind === 'user_message') observation.authoredNow = true;
    if (typeof item['activeNow'] === 'boolean' && (kind === 'assistant_message' || kind === 'page_tool')) observation.activeNow = item['activeNow'];
    if (kind === 'model_selection') {
      if (typeof item['model'] !== 'string' || !/^[a-zA-Z0-9 ._-]{1,80}$/.test(item['model'])) continue;
      observation.model = item['model'];
      if (isReasoningEffort(item['reasoningEffort'])) {
        observation.reasoningEffort = item['reasoningEffort'];
      }
    }
    if (typeof item['text'] === 'string') observation.text = item['text'].slice(0, 256_000);
    if (kind === 'user_message' && typeof item['model'] === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(item['model'])) {
      observation.model = item['model'];
    }
    if (kind === 'user_message' && typeof item['messageId'] === 'string') {
      if (item['reaction'] === null) observation.reaction = null;
      else {
        const reaction = messageReaction(item['reaction']);
        if (reaction) observation.reaction = reaction;
      }
    }
    if (kind === 'user_message' && Array.isArray(item['attachments'])) {
      observation.attachments = item['attachments'].slice(0, 4).filter(file => file && typeof file === 'object' &&
        typeof file.id === 'string' && file.id.length > 0 && file.id.length <= 100 && typeof file.name === 'string' && file.name.length > 0 && file.name.length <= 200 &&
        /^image\/[a-z0-9.+-]{1,80}$/i.test(file.mimeType) && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 512 * 1024 * 1024)
        .map(file => ({ id: file.id, name: file.name, size: file.size, mimeType: file.mimeType }));
    }
    if (typeof item['messageId'] === 'string') {
      if (!item['messageId'].length || item['messageId'].length > 190) continue;
      observation.messageId = item['messageId'];
    }
    if ((kind === 'assistant_message' || (kind === 'turn_end' && item['outcome'] === 'completed')) && typeof item['providerMessageId'] === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item['providerMessageId'])) {
      observation.providerMessageId = item['providerMessageId'];
    }
    if (kind === 'assistant_message' && typeof item['resolvedModel'] === 'string' &&
        /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(item['resolvedModel'])) {
      observation.resolvedModel = item['resolvedModel'];
    }
    if (kind === 'native_image') {
      if (typeof item['messageId'] !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item['messageId']) ||
          typeof item['providerAssetId'] !== 'string' || !/^file_[A-Za-z0-9_-]{8,100}$/.test(item['providerAssetId']) ||
          (item['providerRole'] !== 'tool' && item['providerRole'] !== 'assistant')) continue;
      observation.messageId = item['messageId'];
      observation.providerAssetId = item['providerAssetId'];
      observation.providerRole = item['providerRole'];
      if (item['providerChannel'] === 'final') observation.providerChannel = 'final';
      else if (item['providerChannel'] !== undefined) continue;
      if (item['providerStatus'] === 'in_progress' || item['providerStatus'] === 'finished_successfully') {
        observation.providerStatus = item['providerStatus'];
      } else if (item['providerStatus'] !== undefined) continue;
      const width = Number.isSafeInteger(item['width']) && Number(item['width']) > 0 && Number(item['width']) <= 30_000
        ? Number(item['width']) : undefined;
      const height = Number.isSafeInteger(item['height']) && Number(item['height']) > 0 && Number(item['height']) <= 30_000
        ? Number(item['height']) : undefined;
      if ((item['width'] !== undefined && width === undefined) || (item['height'] !== undefined && height === undefined)) continue;
      if (width) observation.width = width;
      if (height) observation.height = height;
      const previewErrors = new Set(['not_loaded', 'ambiguous', 'tainted', 'oversized', 'invalid', 'quota']);
      if (item['previewStatus'] === 'pending' || item['previewStatus'] === 'available' || item['previewStatus'] === 'unavailable') {
        observation.previewStatus = item['previewStatus'];
      }
      if (typeof item['previewError'] === 'string' && previewErrors.has(item['previewError'])) {
        observation.previewError = item['previewError'] as ChatObservation['previewError'];
      }
      const sourceOversized = Boolean(width && height && width * height > 30_000_000);
      if (sourceOversized) {
        observation.previewStatus = 'unavailable';
        observation.previewError = 'oversized';
      }
      if (typeof item['previewDataUrl'] === 'string') {
        const dataUrl = item['previewDataUrl'];
        const previewWidth = Number.isSafeInteger(item['previewWidth']) && Number(item['previewWidth']) > 0 && Number(item['previewWidth']) <= 1600
          ? Number(item['previewWidth']) : undefined;
        const previewHeight = Number.isSafeInteger(item['previewHeight']) && Number(item['previewHeight']) > 0 && Number(item['previewHeight']) <= 1600
          ? Number(item['previewHeight']) : undefined;
        if (!sourceOversized && observation.providerStatus !== 'finished_successfully') {
          observation.previewStatus = 'pending';
          delete observation.previewError;
        } else if (!sourceOversized && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl) && dataUrl.length <= 512_100 &&
            previewWidth && previewHeight && previewWidth * previewHeight <= 2_560_000) {
          observation.previewDataUrl = dataUrl;
          observation.previewWidth = previewWidth;
          observation.previewHeight = previewHeight;
          observation.previewStatus = 'available';
        } else if (!sourceOversized) {
          observation.previewStatus = 'unavailable';
          observation.previewError = 'invalid';
        }
      }
    }
    if (typeof item['turnId'] === 'string') observation.turnId = item['turnId'].slice(0, 100);
    if (item['state'] === 'streaming' || item['state'] === 'final') observation.state = item['state'];
    if (typeof item['fiberConversationId'] === 'string') {
      const fiberId = conversationId(item['fiberConversationId']);
      if (fiberId) observation.fiberConversationId = fiberId;
    }
    if (item['final'] === true) observation.final = true;
    if (typeof item['outcome'] === 'string' && OUTCOMES.has(item['outcome'])) {
      observation.outcome = item['outcome'] as ChatObservation['outcome'];
    }
    if (((kind === 'turn_end' && observation.outcome === 'failed') || kind === 'chat_error') && item['reason'] === 'thinking_failed') {
      observation.reason = 'thinking_failed';
    }
    if (kind === 'chat_error' && item['reason'] === 'stream_gone') observation.reason = 'stream_gone';
    if (
      item['goalEligible'] === true &&
      kind === 'assistant_message' &&
      item['final'] === true &&
      item['state'] === 'final'
    ) {
      observation.goalEligible = true;
    }
    if (typeof item['detail'] === 'string') observation.detail = item['detail'].slice(0, 500);
    if (typeof item['recoverable'] === 'boolean') observation.recoverable = item['recoverable'];
    if (item['blocking'] === true) observation.blocking = true;
    if (Array.isArray(item['calls'])) observation.calls = parseCallEvidence(item['calls']);
    out.push(observation);
  }
  return out;
}
