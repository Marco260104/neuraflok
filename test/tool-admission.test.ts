import { describe, expect, it } from 'vitest';
import {
  resolveToolAdmission,
  type ToolAdmissionInput,
  type ToolAdmissionRefusal
} from '../backend/infrastructure/tool-gateway/protocol/tool-admission.js';

const base = (): ToolAdmissionInput => ({
  policyRefusal: null,
  compacting: false,
  compactionRefusal: 'compacting',
  supersededConversation: false,
  silentCeilingWorker: null,
  dormantWorker: null,
  retiredWorker: null,
  endedWorker: null,
  retiredLeaseAmbiguous: false,
  dormantLeaseAmbiguous: false,
  missingSwarmIdentity: () => false,
  nested: false,
  name: 'read',
  finishCall: false
});

function expectRefusal(result: ToolAdmissionRefusal | null, kind: ToolAdmissionRefusal['kind'], prefix: string): void {
  expect(result?.kind).toBe(kind);
  expect(result?.message.startsWith(prefix)).toBe(true);
}

describe('MCP tool admission', () => {
  it('preserves policy and conversation-fence precedence', () => {
    expect(resolveToolAdmission({ ...base(), policyRefusal: 'blocked', compacting: true })).toEqual({
      kind: 'tool',
      message: 'blocked'
    });
    expect(resolveToolAdmission({ ...base(), compacting: true, supersededConversation: true })).toEqual({
      kind: 'tool',
      message: 'compacting'
    });
  });

  it('preserves worker lifecycle precedence', () => {
    expectRefusal(resolveToolAdmission({
      ...base(),
      retiredWorker: { id: 'worker-2', reason: 'run ended' },
      endedWorker: 'ended'
    }), 'tool', 'WORKER_RETIRED: worker-2');
  });

  it('refuses ambiguous retired-worker identity before checking swarm identity', () => {
    expectRefusal(resolveToolAdmission({
      ...base(),
      retiredLeaseAmbiguous: true,
      missingSwarmIdentity: () => { throw new Error('later policy must not run'); }
    }), 'identity', 'CALLER_IDENTITY_REQUIRED:');
  });

  it('requires exact workspace identity during an active swarm', () => {
    expectRefusal(resolveToolAdmission({ ...base(), missingSwarmIdentity: () => true }), 'identity', 'CALLER_IDENTITY_REQUIRED:');
  });

  it('requires lifecycle tools to be called directly while allowing ordinary nested tools', () => {
    expectRefusal(resolveToolAdmission({ ...base(), nested: true, name: 'session_finish' }), 'tool', 'DIRECT_CALL_REQUIRED:');
    expectRefusal(resolveToolAdmission({ ...base(), nested: true, name: 'agents', finishCall: true }), 'tool', 'DIRECT_CALL_REQUIRED:');
    expect(resolveToolAdmission({ ...base(), nested: true, name: 'read' })).toBeNull();
  });

  it('allows a call when no admission fence applies', () => {
    expect(resolveToolAdmission(base())).toBeNull();
  });
});
