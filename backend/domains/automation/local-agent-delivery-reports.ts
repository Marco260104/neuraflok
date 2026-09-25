import { logWarn } from '../../infrastructure/settings/logger.js';
import { recordAgentMessage } from '../sessions/history/recorder.js';
import { failWorkerRevival, persistCriticalSwarmNow } from './agents.js';

export async function persistAgentChange(): Promise<boolean> {
  try {
    return await persistCriticalSwarmNow();
  } catch (error) {
    logWarn(`multi-agent: local worker state is not durable yet: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function recordAgentDeliveryReport(
  report: Awaited<ReturnType<typeof failWorkerRevival>>,
  conversationId: string | null
): Promise<void> {
  if (!report || !(await persistAgentChange())) return;
  await recordAgentMessage(report, 'sent', conversationId);
}
