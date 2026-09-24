
export type AgentRole = 'prime' | 'worker';
/** Separates worker execution state from provider page visibility. */
export type AgentState =
  | 'invited'
  | 'active'
  | 'detached'
  | 'waking'
  | 'sleeping'
  | 'finished'
  | 'failed';

/** Canonical reasoning levels for a worker's chat, shared with the Hermes runtime vocabulary (hermes_constants.VALID_REASONING_EFFORTS plus "none"). "none" is a real level — reasoning disabled — and is distinct from null, which means inherit the account default. This is the single vocabulary authority; the broker, the bridge restore and the extension all check membership against this list. */
export const REASONING_EFFORTS = [
  'pro', // Provider browser Power tier; never forwarded as an API reasoning effort.
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export interface AgentInfo {
  /** Broker owner projection. IDs such as worker-1 are local to this incarnation. */
  runId?: string;
  primeConversationId?: string;
  id: string;
  role: AgentRole;
  /** Current job name; preserved on reuse unless the prime explicitly renames it. */
  label: string;
  /** Spawn brief, or a bounded inbox preview for the current reused assignment. */
  task: string;
  /** Requested reasoning level for this worker's chat, or null to inherit the default. Canonical vocabulary shared with the Hermes runtime (VALID_REASONING_EFFORTS plus "none"). "none" is a real level — reasoning disabled — distinct from null. Stored where the worker's model is stored and matched, snapshotted and restored the same way. */
  reasoningEffort: ReasoningEffort | null;
  /** provider model ID this worker's chat was opened with, or null for the account default. Chosen by the prime at spawn, never by the worker: the model is fixed by the fresh-chat URL the tab opens with, so a worker keeps it for the life of its conversation, including across sleep/wake reuse. Null for the prime, which runs in the user's own chat. */
  model: string | null;
  state: AgentState;
  createdAt: number;
  /** When the app bound this agent to its conversation and started it. Set by the app, never by the model: a worker is activated by the extension reporting the chat it opened for the slot, which happens before that chat has said anything. */
  activatedAt: number | null;
  finishedAt: number | null;
  /** Current completion report; cleared when work resumes. Prior reports remain in history/inbox. */
  result: string | null;
  /** Messages waiting for this agent, including offered-but-unacknowledged ones. */
  pending: number;
  /** Of those, how many have gone out at least once and are awaiting proof of receipt. */
  awaitingAck: number;
  /** Messages this agent has demonstrably received. */
  delivered: number;
  /** Exact provider conversation bound to this agent. */
  conversationId: string | null;
  /** Time the provider page detached while its worker remained active. */
  detachedAt: number | null;
  /** The last moment this app had first-hand evidence that this agent's conversation exists. Exactly two things stamp it: an MCP call proved by the request-id correlation, and the agent's own page reporting to the bridge. One clock, so a worker whose tab is open is never on the silence clock at all. It is what revives a detached agent, and — when it stops advancing — what eventually ends one nobody can see any more. */
  lastSeenAt: number | null;
  /** Context-ceiling completion, failed opening, and user removal make a worker terminal. */
  revivable: boolean;
  /** Durable reason that this stopped worker released its slot on ambiguous silence, not completion. */
  silenceParked?: boolean;
  /** Exact unresolved server-turn identity retained alongside silenceParked when recorder evidence has one. This never grants a new-task wake; only exact same-turn recovery may consume it. */
  silenceRecoveryTurnId?: string | null;
  /** Highest durable journal origin that existed when silence parked this worker. Same-turn MCP recovery accepts only request ownership already present at or before this boundary. */
  silenceRecoveryRequestOriginMax?: number | null;
  /** Bridge command id of the most recent revival whose user message the provider accepted. This is crash-recovery evidence for the narrow window where the worker snapshot was fsynced but the bridge command receipt was not. It is never used to decide whether a worker may be revived; it only makes a retry of that exact browser ACK idempotent. */
  lastRevivalCommandId?: string | null;
  /** When this agent last stopped working without ending, or null. Distinct from `finishedAt`, which is only ever set by a terminal state. A worker that has slept three times and been woken twice has a `sleptAt` and no `finishedAt` at all. */
  sleptAt: number | null;
  /** This chat's own estimated context, as the local session store measures it. Never a number a model reported: it is the same estimate the composer meter fills against, read off the durable session that records this exact conversation. It is what decides whether a worker is still worth reviving — see {@link revivable}. */
  contextTokens: number;
}

/** One brokered message, with delivery tracked at-least-once — within a stated limit. Marking a message delivered at the moment it is written into a tool result would be a lie the moment the connector drops between the result being built and the provider receiving it — a failure this project has already reproduced — and the message would be gone for good. So a message is only *offered* when it goes out, and retired when the recipient proves it got it by making another authenticated call. The cost is that a message can be shown twice; `id` is stable so the model and the recorder can both tell a repeat from a new message, and a repeat is much cheaper than a loss. The limit, stated rather than glossed: another authenticated call is *evidence* that the previous result arrived, not proof of it. The connector supplies no session id and no request identity (see transportIdentityStatus), so a retry of a call whose result was lost is indistinguishable from the next call of one that arrived — and retirement on that call would drop a message the model never saw. `offeredOnFinish` narrows the one place where that is unrecoverable rather than merely annoying. */
export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  /** Prime-family address of the sender when a message crosses between existing prime families. Agent ids are only unique inside one family, so a bare `from: "prime"` cannot be replied to across that boundary. This is routing metadata only; it grants no status or worker access to the receiving prime. */
  fromRunId?: string;
  time: number;
  text: string;
  /** When it was last written into a tool result. Re-offered until acknowledged. */
  offeredAt: number | null;
  /** How many times it has been offered, so a repeat can be labelled as one. */
  offers: number;
  /** Last written into a result for a `finish_agent` call. That is the one call an agent repeats verbatim when its result goes missing, and the one whose next call therefore proves nothing — a finish that never came back is answered by another finish. Retiring on it would hand the agent's own retry as evidence that it read something it never saw, and then terminalise it. So a message carrying this flag is not retired by a finish; it is re-offered, and only an ordinary tool call — the kind an agent makes because it went back to work — retires it. */
  offeredOnFinish: boolean;
  /** This row was delivered by the browser as a real user message while reviving a sleeping worker, rather than merely being copied into an MCP result. That distinction is durable and stronger than an ordinary offer. Once the provider accepted the injected user message, replaying the same row through the worker's next tool result would duplicate the prime's instruction inside one turn. A later authenticated worker call may acknowledge the row, but the broker must never *offer* it again, including after an app restart where ordinary result offers deliberately become uncertain and are reset. */
  offeredViaRevival: boolean;
  /** Set once the recipient has demonstrably received it. */
  ackedAt: number | null;
}

export interface SwarmState {
  enabled: boolean;
  /** True while at least one worker is invited or active. */
  running: boolean;
  /** Local-app presentation hint: worker histories exist but are parked outside the active run. Caller/model status remains scoped separately and never uses this to reveal another owner. */
  retainedHistory?: boolean;
  /** Local UI projection of dormant workers; never grants caller/model access. */
  retainedWorkers?: AgentInfo[];
  agents: AgentInfo[];
}

/** The result of the user clearing one agent row in the app. `cleared` is what actually happened, not what was asked for: clearing the prime ends the whole run, clearing a worker frees that one slot, and clearing a row that had already ended does nothing at all. The UI reports this rather than assuming the click worked. */
export interface ClearAgentResult {
  cleared: 'run' | 'worker' | 'none';
  reason: string;
  swarm: SwarmState;
}

