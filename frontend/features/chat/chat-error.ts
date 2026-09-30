import type { SessionEvent } from '../../../contracts/session.js';
import { collectChatErrorEvidence, duplicateChatErrors } from './chat-error/history-evidence.js';
import { presentChatError } from './chat-error/presentation.js';

type ChatError = Extract<SessionEvent, { kind: 'chat_error' }>;

export { duplicateChatErrors };

export function chatErrorPresentation(error: ChatError, history: readonly SessionEvent[] = []) {
  const duplicates = duplicateChatErrors(history);
  return presentChatError(error, collectChatErrorEvidence(error, history, duplicates));
}
