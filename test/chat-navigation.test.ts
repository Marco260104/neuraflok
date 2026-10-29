import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../contracts/session.js';
import { shouldStopDeepseekTurnOnProjectSwitch } from '../frontend/features/chat/chat-navigation.js';

const deepseekSession = {
  conversationId: 'ds-00000000-0000-4000-8000-000000000001'
} as SessionSummary;

describe('DeepSeek project-switch suspension', () => {
  it('stops a DeepSeek session when leaving a project context', () => {
    expect(shouldStopDeepseekTurnOnProjectSwitch('project-a', 'project-b', deepseekSession)).toBe(true);
    expect(shouldStopDeepseekTurnOnProjectSwitch('project-a', null, deepseekSession)).toBe(true);
    expect(shouldStopDeepseekTurnOnProjectSwitch(null, 'project-a', deepseekSession)).toBe(true);
  });

  it('keeps turns running when the user stays in the same project or in normal chats', () => {
    expect(shouldStopDeepseekTurnOnProjectSwitch('project-a', 'project-a', deepseekSession)).toBe(false);
    expect(shouldStopDeepseekTurnOnProjectSwitch(null, null, deepseekSession)).toBe(false);
  });

  it('does not stop non-DeepSeek providers or managed worker chats', () => {
    expect(shouldStopDeepseekTurnOnProjectSwitch('project-a', 'project-b', {
      ...deepseekSession, conversationId: 'km-00000000-0000-4000-8000-000000000001'
    } as SessionSummary)).toBe(false);
    expect(shouldStopDeepseekTurnOnProjectSwitch('project-a', 'project-b', {
      ...deepseekSession, origin: { kind: 'worker', fromSessionId: null, agentId: 'worker-1', task: 'test' }
    })).toBe(false);
  });
});
