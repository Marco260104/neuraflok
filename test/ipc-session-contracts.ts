import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
} from 'vitest';
import { promises as fs } from 'node:fs';
import {
  handlers,
  getConfig,
  appendEvent,
  createSession,
  getSession,
  rebindSession,
  flushDurable,
  writeDurableNow,
  bindConversation,
  spawn,
  openInPreferredBrowser,
  loadIntegratedBrowser,
  faultGate,
  sessionEvents,
  sessionList,
} from './ipc-context.js';
describe('session IPC contracts', () => {
  beforeEach(async () => {
    const { resetTrustedChatsForTests } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
    resetTrustedChatsForTests();
    await writeDurableNow('trusted-chats', { version: 1, entries: [] });
  });

  it('projects absent live activity without persisting the runtime deadline', async () => {
    const { observeSessionModel, getSession } = await import('../backend/domains/sessions/history/store.js');
    const pro = await createSession({ title: 'Idle Pro', conversationId: 'idle-pro-projection' });
    const sol = await createSession({ title: 'Idle Sol', conversationId: 'idle-sol-projection' });
    await observeSessionModel(pro.id, pro.conversationId!, 'gpt-6', Date.now(), 'pro');
    await observeSessionModel(sol.id, sol.conversationId!, 'gpt-5.6', Date.now(), 'medium');
    const reply = await sessionList();
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.sessions.find((row: any) => row.id === pro.id).activityExpiresAt).toBeNull();
    expect(reply.data.sessions.find((row: any) => row.id === sol.id).activityExpiresAt).toBeNull();
    expect(await getSession(pro.id)).not.toHaveProperty('activityExpiresAt');
  });

  it('keeps total as the whole session size on an explicit event page', async () => {
    const session = await createSession({ title: 'paged IPC total', conversationId: null });
    for (let index = 0; index < 5; index++) {
      await appendEvent(session.id, {
        time: 10_000 + index,
        source: 'app',
        kind: 'note',
        message: { text: `note-${index}`, truncated: false, chars: 6 }
      });
    }

    const reply = await sessionEvents({ id: session.id, from: 3, limit: 2 });
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.events).toHaveLength(2);
    expect(reply.data.total).toBe(5);
  });

  it('does not send pressure rows for sessions it already omitted from the capped list', async () => {
    for (let index = 0; index < 61; index++) {
      await createSession({ title: `list cap ${index}`, conversationId: null });
    }
    const reply = await sessionList();
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.sessions).toHaveLength(60);
    expect(reply.data.pressure).toHaveLength(60);
    expect(new Set(reply.data.pressure.map((entry: { id: string }) => entry.id))).toEqual(
      new Set(reply.data.sessions.map((entry: { id: string }) => entry.id))
    );
  });

  it('projects compaction pressure from the current chat context, not session lifetime history', async () => {
    const chatA = 'aaaaaaaa-1111-2222-3333-444444444444';
    const chatB = 'bbbbbbbb-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'reset context pressure', conversationId: chatA });
    await appendEvent(session.id, {
      time: Date.now(),
      source: 'app',
      kind: 'note',
      message: { text: 'x'.repeat(8_000), truncated: false, chars: 8_000 }
    });
    expect(await rebindSession(session.id, chatA, chatB)).toBe(true);

    const reply = await sessionList();
    const listed = reply.data.sessions.find((entry: { id: string }) => entry.id === session.id);
    const pressure = reply.data.pressure.find((entry: { id: string }) => entry.id === session.id);
    expect(listed.estimatedTokens).toBeGreaterThan(0);
    expect(listed.contextTokens).toBe(0);
    expect(pressure.estimated).toBe(0);
    expect(pressure.level).toBe('ok');
  });

  it('blocks and releases the stored conversation, and never a renderer-supplied one', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../backend/domains/sessions/continuity/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'rogue chat', conversationId });

    const blocked = (await handlers.get('sessions:block')!(null, { id: session.id, blocked: true })) as any;
    expect(blocked.ok, blocked.error).toBe(true);
    expect(blocked.data).toEqual([conversationId]);
    expect(isChatBlocked(conversationId)).toBe(true);

    const released = (await handlers.get('sessions:block')!(null, { id: session.id, blocked: false })) as any;
    expect(released.ok, released.error).toBe(true);
    expect(released.data).toEqual([]);
    expect(isChatBlocked(conversationId)).toBe(false);

    // The renderer names a session; it can neither name a conversation nor block a session that has none — the same boundary `sessions:openChat` holds.
    const unattributed = await createSession({ title: 'no conversation', conversationId: null });
    const refused = (await handlers.get('sessions:block')!(null, { id: unattributed.id, blocked: true })) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/no valid provider conversation/i);
    resetBlockedChatsForTests();
  });

  it('trusts and untrusts only the stored conversation for strict allowlisting', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
    resetTrustedChatsForTests();
    const conversationId = 'dddddddd-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'trusted chat', conversationId });

    const trusted = (await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: conversationId, trusted: true
    })) as any;
    expect(trusted.ok, trusted.error).toBe(true);
    expect(trusted.data).toEqual([conversationId]);
    expect(isChatTrusted(conversationId)).toBe(true);

    const untrusted = (await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: conversationId, trusted: false
    })) as any;
    expect(untrusted.ok, untrusted.error).toBe(true);
    expect(untrusted.data).toEqual([]);
    expect(isChatTrusted(conversationId)).toBe(false);

    const unattributed = await createSession({ title: 'no conversation to trust', conversationId: null });
    const refused = (await handlers.get('sessions:trust')!(null, {
      id: unattributed.id, expectedConversationId: conversationId, trusted: true
    })) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/no valid provider conversation/i);
    resetTrustedChatsForTests();
  });

  it('refuses direct worker Trust while allowing its prime and stale worker Untrust cleanup', async () => {
    const { isChatTrusted, resetTrustedChatsForTests, setChatTrusted } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
    resetTrustedChatsForTests();
    const primeConversationId = 'strict-prime-ipc-owner';
    const workerConversationId = 'strict-worker-ipc-owned';
    const primeSession = await createSession({ title: 'strict prime owner', conversationId: primeConversationId });
    const run = spawn({ caller: { conversationId: primeConversationId }, workers: [{ task: 'owned work' }] });
    expect(bindConversation('worker-1', workerConversationId, run.runId)).toBe(true);
    const workerSession = await createSession({
      title: 'strict owned worker',
      conversationId: workerConversationId,
      origin: { kind: 'worker', fromSessionId: primeSession.id, agentId: 'worker-1', task: 'owned work' }
    });

    try {
      const workerTrust = (await handlers.get('sessions:trust')!(null, {
        id: workerSession.id, expectedConversationId: workerConversationId, trusted: true
      })) as any;
      expect(workerTrust.ok).toBe(false);
      expect(workerTrust.error).toMatch(/worker chats cannot be trusted directly/i);
      expect(isChatTrusted(workerConversationId)).toBe(false);

      const primeTrust = (await handlers.get('sessions:trust')!(null, {
        id: primeSession.id, expectedConversationId: primeConversationId, trusted: true
      })) as any;
      expect(primeTrust.ok, primeTrust.error).toBe(true);
      expect(isChatTrusted(primeConversationId)).toBe(true);

      // A pre-fix durable worker bit is not authority anymore, but Untrust must remain usable to clean it up rather than trapping stale state behind the new guard.
      await setChatTrusted(workerConversationId, true);
      const cleanup = (await handlers.get('sessions:trust')!(null, {
        id: workerSession.id, expectedConversationId: workerConversationId, trusted: false
      })) as any;
      expect(cleanup.ok, cleanup.error).toBe(true);
      expect(isChatTrusted(workerConversationId)).toBe(false);
    } finally {
      resetTrustedChatsForTests();
    }
  });

  it('refuses direct Trust for durable worker identity after broker ownership is gone', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
    resetTrustedChatsForTests();
    const workerConversationId = 'strict-worker-durable-only';
    const workerSession = await createSession({
      title: 'durable worker without retained broker owner',
      conversationId: workerConversationId,
      origin: { kind: 'worker', fromSessionId: null, agentId: 'worker-7', task: 'old retained work' }
    });

    const refused = (await handlers.get('sessions:trust')!(null, {
      id: workerSession.id, expectedConversationId: workerConversationId, trusted: true
    })) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/worker chats cannot be trusted directly/i);
    expect(isChatTrusted(workerConversationId)).toBe(false);
    resetTrustedChatsForTests();
  });

  it('refuses stale trust intent after Compact & Resume rebinds the same session to a new chat', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
    resetTrustedChatsForTests();
    const chatA = '11111111-aaaa-bbbb-cccc-111111111111';
    const chatB = '22222222-aaaa-bbbb-cccc-222222222222';
    const session = await createSession({ title: 'rebound trust', conversationId: chatA });
    expect(await rebindSession(session.id, chatA, chatB)).toBe(true);

    const stale = (await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: chatA, trusted: true
    })) as any;
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/moved to another provider conversation/i);
    expect(isChatTrusted(chatA)).toBe(false);
    expect(isChatTrusted(chatB)).toBe(false);

    const current = (await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: chatB, trusted: true
    })) as any;
    expect(current.ok, current.error).toBe(true);
    expect(isChatTrusted(chatB)).toBe(true);
    resetTrustedChatsForTests();
  });

  it('serializes Trust with Compact & Resume so an in-flight stale A action cannot authorize B', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
    resetTrustedChatsForTests();
    const chatA = '12121212-aaaa-bbbb-cccc-121212121212';
    const chatB = '34343434-aaaa-bbbb-cccc-343434343434';
    const session = await createSession({ title: 'trust raced with resume', conversationId: chatA });
    const gate = faultGate();
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args: Parameters<typeof fs.rename>) => {
      await gate.hold();
      return originalRename(...args);
    });
    try {
      const moving = rebindSession(session.id, chatA, chatB, 'handoff-trust-race-0001');
      await gate.entered;
      let trustSettled = false;
      const trusting = (handlers.get('sessions:trust')!(null, {
        id: session.id, expectedConversationId: chatA, trusted: true
      }) as Promise<any>).then((result) => { trustSettled = true; return result; });
      await Promise.resolve();
      expect(trustSettled).toBe(false);

      gate.release();
      expect(await moving).toBe(true);
      const stale = await trusting;
      expect(stale.ok).toBe(false);
      expect(stale.error).toMatch(/moved to another provider conversation/i);
      expect(isChatTrusted(chatA)).toBe(false);
      expect(isChatTrusted(chatB)).toBe(false);
    } finally {
      gate.release();
      rename.mockRestore();
      resetTrustedChatsForTests();
    }
  });

  it('Untrust on the current resumed row revokes the explicit source instead of leaving inherited authority', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
    const { conversationAccessRefusal } = await import('../backend/domains/sessions/continuity/conversation-access.js');
    resetTrustedChatsForTests();
    const chatA = '33333333-aaaa-bbbb-cccc-333333333333';
    const chatB = '44444444-aaaa-bbbb-cccc-444444444444';
    const session = await createSession({ title: 'inherited resumed trust', conversationId: chatA });
    getConfig().multiAgent.strictChatAllowlist = true;
    try {
      const trustA = (await handlers.get('sessions:trust')!(null, {
        id: session.id, expectedConversationId: chatA, trusted: true
      })) as any;
      expect(trustA.ok, trustA.error).toBe(true);
      expect(await rebindSession(session.id, chatA, chatB, 'handoff-resume-trust-0001')).toBe(true);
      expect(await conversationAccessRefusal(chatB)).toBeNull();
      expect(isChatTrusted(chatA)).toBe(true);
      expect(isChatTrusted(chatB)).toBe(false);

      const untrustB = (await handlers.get('sessions:trust')!(null, {
        id: session.id, expectedConversationId: chatB, trusted: false
      })) as any;
      expect(untrustB.ok, untrustB.error).toBe(true);
      expect(untrustB.data).toEqual([]);
      expect(isChatTrusted(chatA)).toBe(false);
      expect(isChatTrusted(chatB)).toBe(false);
      expect(await conversationAccessRefusal(chatB)).toMatch(/^CHAT_NOT_TRUSTED:/);
    } finally {
      getConfig().multiAgent.strictChatAllowlist = false;
      resetTrustedChatsForTests();
    }
  });

  it('Release on the current resumed row clears a blocking source without removing its Trust', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../backend/domains/sessions/continuity/blocked-chats.js');
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
    const { conversationAccessRefusal } = await import('../backend/domains/sessions/continuity/conversation-access.js');
    resetBlockedChatsForTests();
    resetTrustedChatsForTests();
    const chatA = '77777777-aaaa-bbbb-cccc-777777777777';
    const chatB = '88888888-aaaa-bbbb-cccc-888888888888';
    const session = await createSession({ title: 'blocked resumed source', conversationId: chatA });
    getConfig().multiAgent.strictChatAllowlist = true;
    try {
      expect(((await handlers.get('sessions:trust')!(null, {
        id: session.id, expectedConversationId: chatA, trusted: true
      })) as any).ok).toBe(true);
      expect(((await handlers.get('sessions:block')!(null, { id: session.id, blocked: true })) as any).ok).toBe(true);
      expect(await rebindSession(session.id, chatA, chatB, 'handoff-release-block-0001')).toBe(true);
      expect(await conversationAccessRefusal(chatB)).toMatch(/^CHAT_NOT_TRUSTED:/);

      const released = (await handlers.get('sessions:block')!(null, { id: session.id, blocked: false })) as any;
      expect(released.ok, released.error).toBe(true);
      expect(isChatBlocked(chatA)).toBe(false);
      expect(isChatBlocked(chatB)).toBe(false);
      expect(isChatTrusted(chatA)).toBe(true);
      expect(await conversationAccessRefusal(chatB)).toBeNull();
    } finally {
      getConfig().multiAgent.strictChatAllowlist = false;
      resetBlockedChatsForTests();
      resetTrustedChatsForTests();
    }
  });

  it('releases a block when the row that carries its button is deleted', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../backend/domains/sessions/continuity/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'bbbbbbbb-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'blocked then deleted', conversationId });
    await handlers.get('sessions:block')!(null, { id: session.id, blocked: true });
    expect(isChatBlocked(conversationId)).toBe(true);

    const deleted = (await handlers.get('sessions:delete')!(null, { id: session.id })) as any;
    expect(deleted.ok, deleted.error).toBe(true);
    // Otherwise the conversation stays refused with nothing left in the app to release it.
    expect(isChatBlocked(conversationId)).toBe(false);
  });

  it('removes trust when the row that carries its button is deleted', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
    resetTrustedChatsForTests();
    const conversationId = 'eeeeeeee-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'trusted then deleted', conversationId });
    await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: conversationId, trusted: true
    });
    expect(isChatTrusted(conversationId)).toBe(true);

    const deleted = (await handlers.get('sessions:delete')!(null, { id: session.id })) as any;
    expect(deleted.ok, deleted.error).toBe(true);
    expect(isChatTrusted(conversationId)).toBe(false);
    resetTrustedChatsForTests();
  });

  it('deleting a resumed row atomically revokes hidden explicit source trust', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
    const { conversationAccessRefusal } = await import('../backend/domains/sessions/continuity/conversation-access.js');
    resetTrustedChatsForTests();
    const chatA = '55555555-aaaa-bbbb-cccc-555555555555';
    const chatB = '66666666-aaaa-bbbb-cccc-666666666666';
    const session = await createSession({ title: 'resumed trust deleted', conversationId: chatA });
    getConfig().multiAgent.strictChatAllowlist = true;
    try {
      const trusted = (await handlers.get('sessions:trust')!(null, {
        id: session.id, expectedConversationId: chatA, trusted: true
      })) as any;
      expect(trusted.ok, trusted.error).toBe(true);
      expect(await rebindSession(session.id, chatA, chatB, 'handoff-delete-trust-0001')).toBe(true);
      expect(await conversationAccessRefusal(chatB)).toBeNull();

      const deleted = (await handlers.get('sessions:delete')!(null, { id: session.id })) as any;
      expect(deleted.ok, deleted.error).toBe(true);
      expect(isChatTrusted(chatA)).toBe(false);
      expect(isChatTrusted(chatB)).toBe(false);

      await createSession({ title: 'old source returned', conversationId: chatA });
      expect(await conversationAccessRefusal(chatA)).toMatch(/^CHAT_NOT_TRUSTED:/);
    } finally {
      getConfig().multiAgent.strictChatAllowlist = false;
      resetTrustedChatsForTests();
    }
  });

  it('deleting a resumed row releases a hidden committed source Block', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../backend/domains/sessions/continuity/blocked-chats.js');
    resetBlockedChatsForTests();
    const chatA = '99999999-aaaa-bbbb-cccc-999999999999';
    const chatB = 'aaaaaaaa-aaaa-bbbb-cccc-aaaaaaaaaaaa';
    const session = await createSession({ title: 'resumed source block deleted', conversationId: chatA });
    try {
      expect(((await handlers.get('sessions:block')!(null, { id: session.id, blocked: true })) as any).ok).toBe(true);
      expect(isChatBlocked(chatA)).toBe(true);
      expect(await rebindSession(session.id, chatA, chatB, 'handoff-delete-block-0001')).toBe(true);

      const deleted = (await handlers.get('sessions:delete')!(null, { id: session.id })) as any;
      expect(deleted.ok, deleted.error).toBe(true);
      expect(isChatBlocked(chatA)).toBe(false);
      expect(isChatBlocked(chatB)).toBe(false);
    } finally {
      resetBlockedChatsForTests();
    }
  });

  it('preserves the session, Block and Trust when durable trust revocation fails during delete', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../backend/domains/sessions/continuity/blocked-chats.js');
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
    resetBlockedChatsForTests();
    resetTrustedChatsForTests();
    const conversationId = 'abababab-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'policy survives failed delete', conversationId });
    await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: conversationId, trusted: true
    });
    await handlers.get('sessions:block')!(null, { id: session.id, blocked: true });
    expect(isChatTrusted(conversationId)).toBe(true);
    expect(isChatBlocked(conversationId)).toBe(true);

    // Block saves on a short delay. Settle it first, and fail only the trust file's save: a one-shot failure on whatever renames next went to a late Block save on slow runners.
    await flushDurable();
    const realRename = fs.rename.bind(fs);
    let failed = false;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failed && String(to).includes('trusted-chats')) {
        failed = true;
        throw Object.assign(new Error('simulated trust revoke failure'), { code: 'EIO' });
      }
      return realRename(from, to);
    });
    try {
      const deleted = (await handlers.get('sessions:delete')!(null, { id: session.id })) as any;
      expect(deleted.ok).toBe(false);
      expect(deleted.error).toMatch(/simulated trust revoke failure/i);
      expect(isChatTrusted(conversationId)).toBe(true);
      expect(isChatBlocked(conversationId)).toBe(true);
      expect(await getSession(session.id)).not.toBeNull();
      await flushDurable();
    } finally {
      rename.mockRestore();
      resetBlockedChatsForTests();
      resetTrustedChatsForTests();
    }
  });

  it('fences concurrent Trust while session deletion is waiting on its durable revoke', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
    resetTrustedChatsForTests();
    const conversationId = 'cdcdcdcd-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'trust raced with delete', conversationId });
    await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: conversationId, trusted: true
    });
    expect(isChatTrusted(conversationId)).toBe(true);

    const gate = faultGate();
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args: Parameters<typeof fs.rename>) => {
      await gate.hold();
      return originalRename(...args);
    });
    try {
      const deleting = handlers.get('sessions:delete')!(null, { id: session.id }) as Promise<any>;
      await gate.entered;

      const racedTrust = (await handlers.get('sessions:trust')!(null, {
        id: session.id, expectedConversationId: conversationId, trusted: true
      })) as any;
      expect(racedTrust.ok).toBe(false);
      expect(racedTrust.error).toMatch(/being deleted/i);

      gate.release();
      const deleted = await deleting;
      expect(deleted.ok, deleted.error).toBe(true);
      expect(await getSession(session.id)).toBeNull();
      expect(isChatTrusted(conversationId)).toBe(false);
    } finally {
      gate.release();
      rename.mockRestore();
      resetTrustedChatsForTests();
    }
  });

  it('fences concurrent Block while session deletion is waiting on filesystem removal', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../backend/domains/sessions/continuity/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'efefefef-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'block raced with delete', conversationId });
    await handlers.get('sessions:block')!(null, { id: session.id, blocked: true });
    expect(isChatBlocked(conversationId)).toBe(true);

    const gate = faultGate();
    const originalRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, 'rm').mockImplementationOnce(async (...args: Parameters<typeof fs.rm>) => {
      await gate.hold();
      return originalRm(...args);
    });
    try {
      const deleting = handlers.get('sessions:delete')!(null, { id: session.id }) as Promise<any>;
      await gate.entered;
      expect(isChatBlocked(conversationId)).toBe(false);

      const racedBlock = (await handlers.get('sessions:block')!(null, {
        id: session.id, blocked: true
      })) as any;
      expect(racedBlock.ok).toBe(false);
      expect(racedBlock.error).toMatch(/being deleted/i);

      gate.release();
      const deleted = await deleting;
      expect(deleted.ok, deleted.error).toBe(true);
      expect(await getSession(session.id)).toBeNull();
      expect(isChatBlocked(conversationId)).toBe(false);
    } finally {
      gate.release();
      rm.mockRestore();
      resetBlockedChatsForTests();
    }
  });

  it('reports the blocked set with every session list, so one paint marks every row', async () => {
    const { resetBlockedChatsForTests } = await import('../backend/domains/sessions/continuity/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'cccccccc-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'listed while blocked', conversationId });

    expect((await sessionList()).data.blocked).toEqual([]);
    await handlers.get('sessions:block')!(null, { id: session.id, blocked: true });
    expect((await sessionList()).data.blocked).toEqual([conversationId]);
    resetBlockedChatsForTests();
  });

  it('reports the trusted set with every session list as live access policy', async () => {
    const { resetTrustedChatsForTests } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
    resetTrustedChatsForTests();
    const conversationId = 'ffffffff-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'listed while trusted', conversationId });

    expect((await sessionList()).data.trusted).toEqual([]);
    await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: conversationId, trusted: true
    });
    expect((await sessionList()).data.trusted).toEqual([conversationId]);
    resetTrustedChatsForTests();
  });

  it('opens only the exact stored provider conversation', async () => {
    const conversationId = 'km-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const revealProviderConversation = vi.fn(async () => true);
    vi.mocked(loadIntegratedBrowser).mockResolvedValue({ revealProviderConversation } as never);
    const session = await createSession({
      title: 'open me',
      conversationId
    });
    const reply = await handlers.get('sessions:openChat')!(null, { id: session.id }) as any;
    expect(reply.ok, reply.error).toBe(true);
    expect(revealProviderConversation).toHaveBeenCalledWith('kimi', conversationId);
    expect(openInPreferredBrowser).not.toHaveBeenCalled();

    const revealExtensionSession = vi.spyOn(
      await import('../backend/domains/browser/bridge.js'), 'revealChatInBrowser'
    ).mockResolvedValue(true);
    vi.mocked(loadIntegratedBrowser).mockResolvedValue({
      revealProviderConversation: vi.fn(async () => false)
    } as never);
    const recovered = await createSession({ title: 'recover exact chat', conversationId });
    const recoveredReply = await handlers.get('sessions:openChat')!(null, { id: recovered.id }) as any;
    expect(recoveredReply.ok).toBe(false);
    expect(recoveredReply.error).toMatch(/exact kimi conversation page/i);
    expect(revealExtensionSession).not.toHaveBeenCalled();
    revealExtensionSession.mockRestore();

    const unattributed = await createSession({ title: 'no conversation', conversationId: null });
    const refused = await handlers.get('sessions:openChat')!(null, { id: unattributed.id }) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/no valid provider conversation/i);

    const api = await createSession({ title: 'API chat', conversationId: 'ap-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    const apiRefused = await handlers.get('sessions:openChat')!(null, { id: api.id }) as any;
    expect(apiRefused.ok).toBe(false);
    expect(apiRefused.error).toMatch(/available in the NEURAFLOK workspace/i);
  });
});

