import { recoveryBusyMs } from '../../../contracts/recovery.js';
import { CHAT_SILENCE_MS } from '../../../contracts/session.js';
import { logInfo } from '../../infrastructure/settings/logger.js';
import { activeUntil } from './session-activity.js';
import type { Repair } from './bridge-recovery-types.js';

type RepairAction = 'reloaded' | 'reopened' | 'resumed' | 'preserved' | 'present' | null;

interface Runtime {
  repairsInFlight: Map<string, Repair>;
  awaitingReturn: Set<string>;
  lastBrowserRecoveryAt: Map<string, number>;
  turnRepairSpent: Map<string, { sessionId: string; turnKey: string; token: string; at: number }>;
  compactionRepairCurrent(conversationId: string, repair: Repair): boolean;
  fileSilenceInputTicket(conversationId: string, now: number): Promise<boolean>;
  fileSilenceTickets(conversationIds: readonly string[], now: number): Promise<void>;
  loopAfterTurnFor(conversationId: string): boolean;
  goalActiveFor(conversationId: string): boolean;
  goalWorkerChat(conversationId: string): boolean;
  armSilenceSweep(): void;
  grantActivity(conversationId: string, sessionId: string, at: number, window: number): void;
  repairPurpose(repair: Repair): { to: string; during: string };
  updateRepairProgress(conversationId: string, repair: Repair, text: string): Promise<void>;
}

// Owns the side effects that follow a browser repair receipt.
export function createBridgeRepairConfirmation(runtime: Runtime) {
  const { repairsInFlight, awaitingReturn, lastBrowserRecoveryAt, turnRepairSpent, compactionRepairCurrent,
    fileSilenceInputTicket, fileSilenceTickets, loopAfterTurnFor, goalActiveFor, goalWorkerChat,
    armSilenceSweep, grantActivity, repairPurpose, updateRepairProgress } = runtime;

  async function confirmRepair(token: string, action: RepairAction): Promise<void> {
    for (const [conversationId, repair] of repairsInFlight) {
      if (repair.state === 'handed' && repair.token === token) {
        if (!compactionRepairCurrent(conversationId, repair)) { repairsInFlight.delete(conversationId); return; }
        if (action === 'present') {
          // A tab already reappeared before the browser action, so no reload is waiting to resume.
          logInfo(`bridge: ${conversationId} was already open again; the browser left its tab as it was`);
          repair.state = 'done';
          repairsInFlight.delete(conversationId);
          return;
        }
        if (action === 'preserved' && repair.reason === 'assistant-error') {
          logInfo(`bridge: the browser preserved the recovered page for ${conversationId} without spending its assistant-error reload`);
          await updateRepairProgress(
            conversationId,
            repair,
            `Kept the recovered chat open instead of reloading while ${repairPurpose(repair).during}.`
          );
          if (turnRepairSpent.get(conversationId)?.token === token) turnRepairSpent.delete(conversationId);
          repairsInFlight.delete(conversationId);
          return;
        }
        logInfo(`bridge: the browser confirmed ${repair.reason} recovery for ${conversationId} (${action ?? 'action unspecified'})`);
        repair.state = 'done';
        if (repair.attribution && repair.attribution.incident.firstAttemptAt === null)
          repair.attribution.incident.firstAttemptAt = Date.now();
        if (action !== 'preserved') {
          lastBrowserRecoveryAt.set(conversationId, Date.now());
          awaitingReturn.add(conversationId);
        }
        if (repair.reason === 'silence') {
          const failedGrant = activeUntil.get(conversationId);
          if (failedGrant) failedGrant.until = Date.now() + recoveryBusyMs(failedGrant.model === 'pro');
          // Persist the next existing instruction as soon as this exact refresh is acknowledged. Native readiness and the normal Send receipt still gate delivery.
          const inputFiled = await fileSilenceInputTicket(conversationId, Date.now());
          if (!inputFiled && (loopAfterTurnFor(conversationId) || (failedGrant && failedGrant.model !== 'pro'))) await fileSilenceTickets([conversationId], Date.now());
          // Confirmed refreshes share one- or five-minute activity grants; worker retirement is separate.
          const grant = activeUntil.get(conversationId);
          if (grant && (grant.thinkingFailed || grant.model === 'pro' || goalActiveFor(conversationId) || inputFiled || !goalWorkerChat(conversationId))) {
            armSilenceSweep();
          } else grantActivity(
            conversationId,
            repair.sessionId,
            Date.now(),
            CHAT_SILENCE_MS
          );
        }
        if (repair.reason === 'assistant-error') {
          // The silence watch owns the follow-up and must hold this chat activity grant.
          const watch = activeUntil.get(conversationId);
          logInfo(watch
            ? `bridge: ${conversationId} stays under the silence watch after its error reload (turn ${watch.turnId ?? 'unknown'})`
            : `bridge: ${conversationId} has no activity left for the silence watch after its error reload; no automatic Continue follows unless it works again`);
          // Charge the original question, never the replacement document seen at ACK time.
          if (repair.assistantSource) turnRepairSpent.set(conversationId,
            { sessionId: repair.sessionId, turnKey: repair.assistantSource.key, token: repair.token, at: Date.now() });
        }
        await updateRepairProgress(
          conversationId,
          repair,
          `${action === 'reopened' ? 'Reopened' : action === 'resumed' ? 'Resumed' : 'Reloaded'} chat to ${repairPurpose(repair).to}.`
        );
        return;
      }
    }
  }

  return { confirmRepair };
}
