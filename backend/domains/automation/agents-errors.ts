/** Base error for agent-domain operations. */
export class AgentError extends Error {}

/** Raised when an agents action has no family owned by its conversation. */
export class AgentsBusyError extends AgentError {
  constructor() {
    super(
      'AGENTS_BUSY: no agent family belongs to this conversation. Other primes and their workers are isolated. ' +
        'Call agents action=spawn to create workers owned by this chat.',
    );
  }
}

/** Raised when a worker operation cannot be attributed to a conversation. */
export class IdentityLostError extends AgentError {
  constructor(message?: string) {
    super(
      message ??
        'WORKER_IDENTITY_LOST: NEURAFLOK could not tell which conversation this call came from, so it cannot ' +
          'act on the run from here. No agent operation was performed. Wait briefly and retry this operation once. ' +
          'If it is still refused, preserve your result in the chat and report that delivery is unconfirmed; ' +
          'do not claim the message or finish report reached its recipient.',
    );
  }
}
