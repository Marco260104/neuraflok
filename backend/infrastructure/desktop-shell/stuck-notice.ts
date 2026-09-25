/** Reports exhausted recovery to the user without sending an invented message into the chat. */
import { isStopNoticeText, type StopNoticeText } from '../../../contracts/stop-notice.js';

// The main process opens the app to the associated chat when the user clicks the notice.
let notify: ((title: string, body: string, sessionId: string) => boolean | void) | null = null;

/** The renderer's current translations of the notice texts; English until it publishes them. */
let translations = new Map<StopNoticeText, string>();

/** Registered by the main process, which owns the platform's notification surface. */
export function setStuckNotifier(listener: typeof notify): void {
  notify = listener;
}

/** Reports a stopped chat once recovery ends; notification failure never changes recovery state. */
export function noticeChatStopped(title: StopNoticeText, body: StopNoticeText, sessionId: string): void {
  try {
    notify?.(translations.get(title) ?? title, translations.get(body) ?? body, sessionId);
  } catch {
    // A desktop that cannot show a notice still has the timeline note beside this call.
  }
}

/** Takes bounded translations for known notice texts and replaces the previous language set. */
export function setStopNoticeTranslations(texts: Readonly<Record<string, string>>): void {
  const next = new Map<StopNoticeText, string>();
  for (const [source, text] of Object.entries(texts)) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (isStopNoticeText(source) && value && value.length <= 400) next.set(source, value);
  }
  translations = next;
}
