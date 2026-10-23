/** Validated input contract shared by admission and durable restore. No delivery state lives here. */
import { z } from 'zod';
import { REASONING_EFFORTS } from '../../../../contracts/session.js';
import { MAX_INPUT_IMAGES } from '../../../../contracts/input.js';
import { MAX_PROVIDER_MESSAGE_CHARS } from '../../../../contracts/messaging/provider-message-envelope.js';
import { SKILL_ID_PATTERN } from '../../../../contracts/skills.js';
import { BROWSER_PICKUP_MAX_ATTEMPTS } from '../../../../contracts/recovery.js';
import { attachmentSchema } from './attachments/index.js';

export const inputArgs = z.object({
  projectId: z.string().uuid().nullable().optional(),
  automation: z.enum(['off', 'goal', 'loop']).optional(),
  loopAfterTurn: z.boolean().optional(),
  objective: z.string().trim().max(16000).optional(),
  /** Which existing field holds the human request, before generated workflow wrapping. */
  authoredSource: z.enum(['text', 'objective', 'none']).optional(),
  stages: z.array(z.string().trim().min(1).max(16000)).max(11).optional(),
  images: z.array(z.object({ name: z.string().min(1).max(110), dataUrl: z.string().max(512100).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/) })).max(MAX_INPUT_IMAGES).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
  /** User selected the next exact local-tool response, even before the first call. */
  delivery: z.literal('tool').optional(),
  attachmentDelivery: z.literal('tool').optional(),
  id: z.string().uuid(),
  sessionId: z.string().min(8).max(64).nullable(),
  text: z.string().trim().min(1).max(MAX_PROVIDER_MESSAGE_CHARS),
  mode: z.enum(['auto', 'after-turn', 'finish']),
  afterTurn: z.boolean().optional(),
  dueAt: z.number().int().nonnegative(),
  model: z.string().max(80).nullable(),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable(),
  webProvider: z.enum(['deepseek', 'kimi', 'qwen', 'glm']).optional(),
  /** Hidden web-chat setup: bind the session and wait for NEURAFLOK_READY without a user task. */
  warmup: z.literal(true).optional(),
  /** Keep an authored composer message in the transcript while it waits behind web-chat context setup. */
  warmupDeferred: z.object({ selectionGeneration: z.number().int().nonnegative() }).strict().optional()
});
export type InputArgs = z.infer<typeof inputArgs>;
export const entrySchema = inputArgs.extend({
  /** This exact outbox row owns the first native send of its reserved local session. */
  opening: z.literal(true).optional(),
  /** An explicit retry can keep its unbound local chat instead of reserving another. */
  requestedSessionId: inputArgs.shape.sessionId.optional(),
  /** Frozen automatic routing decision. Empty means routing ran and deliberately chose none. */
  autoSkills: z.array(z.object({ id: z.string().regex(SKILL_ID_PATTERN), revision: z.string().regex(/^[0-9a-f]{64}$/i) }).strict()).max(1).optional(),
  /** Frozen image projection; authored attachment IDs remain the replay identity. */
  toolImages: inputArgs.shape.images,
  /** One after-turn pickup earned by confirmed silence or settled Thinking failed. */
  silenceBoundary: z.object({ turnId: z.string().min(1).max(256), conversationId: z.string().min(1).max(256), workSeq: z.number().int().nonnegative(), acceptedAt: z.number().nonnegative().optional(), listenUntil: z.number().nonnegative().optional(), nativeBusy: z.boolean().optional() }).optional(),
  /** The active turn at admission; its final may already be waiting in the browser journal. */
  queuedTurn: z.object({ conversationId: z.string().min(1).max(256), turnId: z.string().min(1).max(256) }).optional(),
  /** Shared unfinished-response fallback belongs to this question in every mode. */
  recovery: z.object({ questionId: z.string(), episode: z.string().max(200).optional(), pro: z.boolean(), busyUntil: z.number(), phase: z.enum(['ready', 'stopping', 'reloading', 'resumed']), reloadOwner: z.string().optional(),
    /** First withdrawal in a consecutive sequence of pre-send retries. */
    withdrawnSince: z.number().optional(),
    /** A page refused this Continue before claiming it, so it ended unsent; see endRecoveryInput. */
    ended: z.literal('page-final').optional() }).optional(),
  /** Exact tool-free turn this explicit browser correction may interrupt. */
  directTurn: z.object({ id: z.string().min(1).max(256), startedAt: z.number() }).optional(),
  finishOwner: z.object({ turnId: z.string().min(1).max(256), periodic: z.boolean(), mode: z.enum(['goal', 'loop']).optional(), userRequested: z.boolean().optional() }).optional(),
  requestedMode: z.enum(['auto', 'after-turn', 'finish']).optional(),
  transportIntent: z.enum(['tool', 'browser']).optional(),
  /** Frozen local executor custody, committed before any browser publication. */
  localExecutor: z.enum(['api', 'deepseek', 'kimi', 'qwen', 'glm']).optional(),
  text: z.string().min(1).max(240000),
  deliveryText: z.string().min(1).max(240000).optional(),
  /** One checkpoint shares this browser send and its receipt with the user's correction. */
  companionInputId: z.string().uuid().optional(),
  purpose: z.enum(['user', 'decision']).optional(),
  lifetime: z.literal('temporary-planner').optional(),
  decisionProvider: z.enum(['deepseek', 'kimi', 'qwen', 'glm']).optional(),
  decisionConversationId: z.string().min(1).max(256).optional(),
  decisionSourceSessionId: z.string().min(8).max(64).optional(),
  response: z.string().max(16000).optional(),
  state: z.enum(['queued', 'browser', 'tool', 'sent', 'cancelled', 'failed', 'decision']),
  offeredAt: z.number().optional(),
  /** Tool-result corrections remain inside their original generation in history. */
  toolTurnId: z.string().min(1).max(256).optional(),
  sendAuthorizedAt: z.number().optional(),
  requiresAuthorization: z.boolean().optional(),
  /** A browser pickup timeout is safely replayable only before Send authorization. */
  pickupFailedAt: z.number().optional(),
  /** One automatic retry is permitted for an exact, never-authorized browser pickup. */
  pickupRetryCount: z.number().int().nonnegative().optional(),
  /** Browser reload budget for this exact queued input; survives app restart. */
  pickupRecovery: z.object({ attempts: z.number().int().min(0).max(BROWSER_PICKUP_MAX_ATTEMPTS),
    nextAt: z.number().int().positive().optional(), stoppedAt: z.number().int().positive().optional() }).optional(),
  cancelledByUser: z.literal(true).optional(),
  error: z.string().max(200).optional(),
  owner: z.string().nullable(),
  createdAt: z.number(),
  conversationId: z.string().nullable(),
  deliveredSessionId: z.string().min(8).max(64).nullable().optional(),
  messageId: z.string().min(1).max(256).optional(),
  deliveredAt: z.number().optional(),
  stagesApplied: z.boolean().optional(),
  historyRecorded: z.boolean().optional(),
  /** Canonical message exists even when optional image assets could not be saved. */
  historyAnchored: z.boolean().optional(),
  /** Store origin proving the canonical row was committed; never a wall-clock guess. */
  historySeq: z.number().int().positive().optional(),
  completedTurnId: z.string().max(256).optional(),
  queueOrder: z.number().int().nonnegative().optional()
});
export type InputEntry = z.infer<typeof entrySchema>;
