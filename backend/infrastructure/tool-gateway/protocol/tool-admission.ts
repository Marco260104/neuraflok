export interface ToolAdmissionInput {
  policyRefusal: string | null;
  compacting: boolean;
  compactionRefusal: string;
  supersededConversation: boolean;
  silentCeilingWorker: string | null;
  dormantWorker: string | null;
  retiredWorker: { id: string; reason: string } | null;
  endedWorker: string | null;
  retiredLeaseAmbiguous: boolean;
  dormantLeaseAmbiguous: boolean;
  missingSwarmIdentity: () => boolean;
  nested: boolean;
  name: string;
  finishCall: boolean;
}

export type ToolAdmissionRefusal = { kind: 'tool' | 'identity'; message: string };

export function resolveToolAdmission(input: ToolAdmissionInput): ToolAdmissionRefusal | null {
  if (input.policyRefusal) return { kind: 'tool', message: input.policyRefusal };
  if (input.compacting) {
    return { kind: 'tool', message: input.compactionRefusal };
  }
  if (input.supersededConversation) {
    return {
      kind: 'tool',
      message: 'CONVERSATION_SUPERSEDED: Compact & Resume replaced this provider conversation. Its transcript remains readable, but it can no longer execute local tools. Continue only in the replacement chat; no local tool was run.'
    };
  }
  if (input.silentCeilingWorker) return { kind: 'tool', message: input.silentCeilingWorker };
  if (input.dormantWorker) return { kind: 'tool', message: input.dormantWorker };
  if (input.retiredWorker) {
    return {
      kind: 'tool',
      message: `WORKER_RETIRED: ${input.retiredWorker.id} was retired because ${input.retiredWorker.reason}. This chat can no longer use local tools. Stop working and return to the prime chat.`
    };
  }
  if (input.endedWorker) return { kind: 'tool', message: input.endedWorker };
  if (input.retiredLeaseAmbiguous) {
    return {
      kind: 'identity',
      message: 'CALLER_IDENTITY_REQUIRED: a recently retired worker tab may still be open, and the connector could not prove this call belongs to a different chat. No local tool was run. For a browser chat, restore the companion connection and retry. Scheduled or headless runs may have no browser identity: the user can enable "Allow unattributed calls" in the app settings to permit self-contained calls recorded as Unattributed. Exact retired-worker restrictions still apply.'
    };
  }
  if (input.dormantLeaseAmbiguous) {
    return {
      kind: 'identity',
      message: 'CALLER_IDENTITY_REQUIRED: a dormant worker chat still belongs to its prime history, and the connector could not prove this call belongs to a different conversation. No local tool was run. For a browser chat, restore the companion connection and retry. Scheduled or headless runs may have no browser identity: the user can enable "Allow unattributed calls" in the app settings to permit self-contained calls recorded as Unattributed. This does not identify the caller or grant access to another chat’s workspace or processes.'
    };
  }
  if (input.missingSwarmIdentity()) {
    return {
      kind: 'identity',
      message: 'CALLER_IDENTITY_REQUIRED: this operation needs this chat’s exact workspace, but the connector could not prove which provider conversation made the call. Retry after the extension reconnects; no file or command was changed.'
    };
  }
  if (input.nested && (input.name === 'exec' || input.name === 'session_finish' || input.finishCall)) {
    return { kind: 'tool', message: 'DIRECT_CALL_REQUIRED: call this lifecycle tool directly, outside exec. No action was taken.' };
  }
  return null;
}
