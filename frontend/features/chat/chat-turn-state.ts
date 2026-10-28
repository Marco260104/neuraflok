import type { SessionEvent } from '../../../contracts/session.js';

/** True when the latest authored question has a recorded terminal event after it. */
export function transcriptShowsCompletedLatestTurn(events: readonly SessionEvent[]): boolean {
  let latestUser = -1;
  let latestTerminal = -1;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.kind === 'user_message') latestUser = index;
    else if ((event.kind === 'turn_end' && event.outcome !== 'unknown') ||
      (event.kind === 'assistant_message' && event.final === true) || event.kind === 'chat_error') {
      latestTerminal = index;
    }
  }
  return latestUser >= 0 && latestTerminal > latestUser;
}
