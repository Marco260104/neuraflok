import { DEFAULT_HANDOFF_LENGTH, DEFAULT_HANDOFF_PROMPT, handoffPromptForLength, type HandoffLength } from '../../../../contracts/sessions/continuity-brief.js';
import { formatContinuationMarker } from '../../../../contracts/sessions/continuation-marker.js';

// Defines the required contents of a handoff brief written by the active conversation.

// Instructs the active conversation to produce the handoff brief as its final answer.
export const sourceContinuationMarker = (token: string): string => formatContinuationMarker('HANDOFF', token);
export const destinationContinuationMarker = (token: string): string => formatContinuationMarker('RESUME', token);

export function nativeHandoffPrompt(
  token = '',
  includeToolCalls = true,
  handoffPrompt = DEFAULT_HANDOFF_PROMPT,
  length: HandoffLength = DEFAULT_HANDOFF_LENGTH
): string {
  const identity = sourceContinuationMarker(token);
  const briefInstructions = handoffPromptForLength(handoffPrompt.trim() || DEFAULT_HANDOFF_PROMPT, length);
  return (
    (identity ? `${identity}\n\n` : '') +
    'NEURAFLOK is compacting this conversation so a fresh chat can continue the work. ' +
    'Stop whatever you were doing and do only this.\n\n' +
    'Write a handoff brief so a different coding agent can continue this unfinished task in a brand-new ' +
    "conversation, with no memory of anything here. Everything you know about this session — the user's " +
    (includeToolCalls ? 'messages, your own replies, and every tool call you made against this machine with its result — is the ' :
      'messages and your own replies, including interim updates — is the ') +
    'material. Write it so an agent who reads only your brief can carry on correctly.\n\n' +
    `${briefInstructions}\n\n` +
    (includeToolCalls ? '' : 'Tool-detail setting: preserve verified outcomes and distinguish them from claims, but omit raw tool-call arguments and result bodies from the brief. Do not copy tool transcripts. This setting controls the brief, not the history you already saw.\n\n') +
    'Your reply to this message must be the brief itself and nothing else: no preamble, no closing remark, no ' +
    'question back, and no tool calls. The app reads this reply, stores it, and opens the fresh chat with it.'
  );
}
