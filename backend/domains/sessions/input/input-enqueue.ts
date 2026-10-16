import { MAX_INPUT_IMAGES, type InputImage } from '../../../../contracts/input.js';
import type { SessionSummary } from '../../../../contracts/session.js';
import { getConfig } from '../../../infrastructure/settings/config.js';
import { getSession } from '../history/store.js';
import { projectWorkspace, getSessionProject } from '../../workspace/projects.js';
import { normalizeInputAttachments, validateInputAttachments } from './attachments/index.js';
import { autoSelectManagedSkills } from '../../skills/skill-routing.js';
import { invokedSkills } from '../../../../contracts/skills/invocation.js';
import { readSessionInputPolicy, type InputActivity } from './input-policy.js';
import { inputArgs, entrySchema, type InputArgs, type InputEntry } from './input-schema.js';

type InputEnqueueRuntime = {
  serial<T>(work: () => Promise<T>): Promise<T>;
  load(): Promise<InputEntry[]>;
  terminal(row: InputEntry): boolean;
  neverAuthorized(row: InputEntry): boolean;
  sessionInputPolicy(sessionId: string): ReturnType<typeof readSessionInputPolicy>;
  activityFor(session: SessionSummary): InputActivity | null;
  materializeOpening(entry: InputEntry): Promise<void>;
  target(entry: InputEntry): Promise<string | null>;
  finishInputCurrent(entry: InputEntry): Promise<boolean>;
  append(current: InputEntry[], entry: InputEntry, stackDirect?: boolean): InputEntry[];
  materializeStages(current: InputEntry[], entry: InputEntry): InputEntry[];
  commit(next: InputEntry[]): Promise<void>;
};

export function createInputEnqueuer(runtime: InputEnqueueRuntime) {
  const { serial, load, terminal, neverAuthorized, sessionInputPolicy, activityFor, materializeOpening,
    target, finishInputCurrent, append, materializeStages, commit } = runtime;
  return function enqueueInput(raw: InputArgs, finishOwner?: InputEntry['finishOwner'], localExecutor?: InputEntry['localExecutor']): Promise<InputEntry> {
    return serial(async () => {
      const input = inputArgs.parse(raw);
      localExecutor = entrySchema.shape.localExecutor.parse(localExecutor);
      if (input.stages !== undefined && JSON.stringify([input.text, ...input.stages]).length > 12000)
        throw new Error('Keep the complete plan below 12,000 characters');
      const current = await load();
      const prior = current.find((entry) => entry.id === input.id);
      if (prior) {
        if (JSON.stringify(inputArgs.parse({ ...prior, sessionId: prior.opening ? prior.requestedSessionId ?? null : prior.sessionId, mode: prior.requestedMode ?? prior.mode })) !== JSON.stringify(input)) throw new Error('Message id already belongs to different input');
        if (!terminal(prior)) await materializeOpening(prior);
        return { ...prior };
      }
      const requestedSession = input.sessionId ? await getSession(input.sessionId) : null;
      // Explicit injection has its own recipient and can never spend a browser completion.
      const activity = requestedSession && input.delivery !== 'tool' && input.attachmentDelivery !== 'tool'
        ? activityFor(requestedSession) : null;
      const sourceTurn = requestedSession?.activeTurnId ?? (activity?.exact ? activity.turnId : null);
      const queuedTurn = requestedSession?.conversationId && sourceTurn
        ? { conversationId: requestedSession.conversationId, turnId: sourceTurn } : undefined;
      let policy = input.sessionId ? await sessionInputPolicy(input.sessionId) : null;
      const previousOpening = [...current].reverse().find(row => row.opening && row.sessionId === input.sessionId);
      // An explicit reviewed resend may replace a proven pre-send failure in the same local chat. An ambiguous native Send still owns its receipt; never replay it.
      const retryOpening = !!(input.sessionId && requestedSession?.origin?.kind === 'desktop' && !requestedSession.conversationId &&
        previousOpening && terminal(previousOpening) && neverAuthorized(previousOpening));
      const requestedMode = input.mode;
      let toolImages: InputImage[] | undefined;
      let injectionOwner: { conversationId: string; turnId: string } | undefined;
      // Inject now reaches the model only as a real message (see sessionInputPolicy): when the running turn takes one, the explicit choice goes through the composer too. Files keep the tool path.
      if (input.delivery === 'tool' && !input.attachmentDelivery && !input.attachments?.length && !input.images?.length &&
          input.mode === 'auto' && !finishOwner && !input.stages?.length && policy?.directTurn) delete input.delivery;
      const toolDelivery = input.delivery === 'tool' || input.attachmentDelivery === 'tool';
      if (toolDelivery) {
        const turnId = policy?.directTurn?.id ?? policy?.injectionTurnId;
        if (!input.sessionId || input.mode !== 'auto' || finishOwner || input.stages?.length || !turnId ||
            (input.images?.length ?? 0) + (input.attachments?.length ?? 0) > MAX_INPUT_IMAGES)
          throw new Error(`Inject up to ${MAX_INPUT_IMAGES} images into an active chat; otherwise use Send or After this turn`);
        const owner = await getSession(input.sessionId);
        if (!owner?.conversationId) throw new Error('Inject into an active chat');
        injectionOwner = { conversationId: owner.conversationId, turnId };
        if (input.attachments?.length) toolImages = await normalizeInputAttachments(input.attachments);
      } else if (input.attachments?.length) {
        await validateInputAttachments(input.attachments);
        // Native files belong to the next browser message, never a tool-result injection.
        if (finishOwner) throw new Error('Automatic finish messages cannot attach files');
        if (input.mode === 'finish' || (input.mode === 'auto' && (policy?.canInject || policy?.directTurn))) input.mode = 'after-turn';
      } else if (input.mode === 'after-turn' && policy?.queueAtFinish) input.mode = 'finish';
      if (input.mode === 'finish' || input.stages?.length) {
        const session = input.sessionId ? await getSession(input.sessionId) : null;
        if ((input.mode === 'finish' && !session?.conversationId) || session?.origin?.kind === 'worker') throw new Error('Queue staged tasks in a normal chat');
      }
      // Unattributed work can fence browser Send without making this chat a tool recipient. Leave that input neutral until the existing serialized claim selects a safe transport.
      const transportIntent = toolDelivery ? 'tool' as const : input.attachments?.length ? 'browser' as const : input.mode === 'auto' && !finishOwner
        ? policy?.canInject ? 'tool' as const : !policy || policy.browserAllowed || policy.directTurn ? 'browser' as const : undefined : undefined;
      const directTurn = !toolDelivery && input.mode === 'auto' && !finishOwner && input.dueAt <= Date.now() ? policy?.directTurn : null;
      const entry: InputEntry = { ...input, ...(localExecutor ? { localExecutor } : {}), ...(queuedTurn ? { queuedTurn } : {}), ...(toolImages ? { toolImages } : {}), ...(directTurn ? { directTurn } : {}),
        ...(injectionOwner ? { toolTurnId: injectionOwner.turnId } : {}), ...(transportIntent ? { transportIntent } : {}),
        ...(requestedMode !== input.mode ? { requestedMode } : {}), ...(finishOwner ? { finishOwner } : {}), state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
      if (input.projectId) {
        await projectWorkspace(input.projectId);
        if (input.sessionId) {
          const session = await getSession(input.sessionId);
          if (session?.projectId !== input.projectId) throw new Error('Message project does not match the session');
          await getSessionProject(input.sessionId);
        }
      }
      const authoredOrdinary = (input.authoredSource ?? 'text') === 'text' && input.mode !== 'finish' &&
        !finishOwner && !input.stages?.length;
      if (getConfig().ui.autoSelectSkills === true && authoredOrdinary && invokedSkills(input.text).length === 0) {
        const folder = input.sessionId ? await getSessionProject(input.sessionId)
          : input.projectId ? await projectWorkspace(input.projectId) : null;
        entry.autoSkills = await autoSelectManagedSkills(input.text, { projectPath: folder?.real ?? null });
      }
      if (retryOpening) { entry.opening = true; entry.requestedSessionId = input.sessionId; }
      // A local opening is admitted before its executor binds the provider chat. Its exact outbox reservation can already own a deferred second message.
      const pendingLocalOpening = localExecutor && input.mode === 'after-turn' &&
        requestedSession?.origin?.kind === 'desktop' && !requestedSession.conversationId &&
        previousOpening?.localExecutor === localExecutor && !terminal(previousOpening);
      entry.conversationId = pendingLocalOpening ? null : await target(entry);
      if (!input.sessionId) {
        entry.opening = true;
        entry.sessionId = input.id;
      }
      if (finishOwner && !(await finishInputCurrent(entry))) throw new Error('The automatic follow-up no longer belongs to an active turn');
      if (injectionOwner) {
        policy = await sessionInputPolicy(input.sessionId!);
        const owner = await getSession(input.sessionId!);
        const turnId = policy.directTurn?.id ?? policy.injectionTurnId;
        if (turnId !== injectionOwner.turnId || owner?.conversationId !== injectionOwner.conversationId || entry.conversationId !== injectionOwner.conversationId)
          throw new Error(input.delivery === 'tool'
            ? 'The active chat changed while preparing injection; send again'
            : 'The active chat changed while preparing images; send again');
      }
      // User input supersedes only automatic work that has never been handed out. Offered tool receipts retain their identity until a later request proves receipt.
      const prioritized = !finishOwner ? current.map(row => row.sessionId === entry.sessionId &&
        ((row.finishOwner && row.state === 'queued') || (row.recovery && !terminal(row) && row.sendAuthorizedAt === undefined))
        ? { ...row, state: 'cancelled' as const, error: 'Replaced by your new instruction before delivery.' } : row) : current;
      let next = append(prioritized, entry, input.mode === 'auto' && !finishOwner && policy?.canInject === true);
      // A finish plan belongs to an existing session now. Publish every editable checkpoint atomically; no composer text or first-send receipt owns its life.
      if (entry.mode === 'finish') next = materializeStages(next, entry);
      await commit(next);
      try { await materializeOpening(entry); }
      catch (error) {
        const failed = { ...entry, error: ('Local chat setup failed: ' + (error as Error).message).slice(0, 200) };
        await commit(next.map(row => row.id === entry.id ? failed : row));
        throw error;
      }
      return { ...next.find(row => row.id === entry.id)! };
    });
  }
}
