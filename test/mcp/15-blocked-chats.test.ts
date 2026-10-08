import {
  addPatch,
  attachSummary,
  beginContinuationSourceSendNow,
  bindConversation,
  claimContinuationNow,
  commitContinuation,
  createSession,
  dispatchContinuationSourceSendNow,
  failed,
  foldProgress,
  fs,
  getConfig,
  modern,
  observeRequestCorrelation,
  onSpawnRequest,
  onSwarmPersistNow,
  openContinuationNow,
  path,
  readRecentEvents,
  rebindSession,
  resetAgentsForTests,
  resetBlockedChatsForTests,
  resetTrustedChatsForTests,
  setChatBlocked,
  setChatTrusted,
  spawn,
  textOf,
  withCaps,
} from './context.js';
import { mcpHarness } from './context.js';
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

/** A user stop must block only the conversation proven to own the incoming request. */
describe('blocked chats', () => {
  const ROGUE = 'conv-blocked-rogue';
  const BYSTANDER = 'conv-innocent-bystander';
  let proofSeq = 0;

  /** Proves one request id belongs to a chat, exactly as the page evidence path would. */
  const owned = (conversationId: string): string => {
    const requestId = `wfr_block_${++proofSeq}`;
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId,
        sessionId: 'session-blocked-chats',
        messageId: `message-block-${proofSeq}`,
        tool: 'read',
        observedAt: Date.now()
      })
    ).toBe('stored');
    return requestId;
  };

  /** Same proof, but tied to a real durable session so app notices can be asserted. */
  const ownedSession = (conversationId: string, sessionId: string): string => {
    const requestId = `wfr_block_session_${++proofSeq}`;
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId,
        sessionId,
        messageId: `message-block-session-${proofSeq}`,
        tool: 'read',
        observedAt: Date.now()
      })
    ).toBe('stored');
    return requestId;
  };

  /** The same proof, deliberately late: the page reporting *after* the call has already landed. This is the ordinary order, not an exotic one. A turn's first call races its own evidence, and the wedged page this feature exists for is the slowest reporter there is. The recorder has always waited for exactly this and filed the call under the chat it proves, which is why a blocked chat could be seen running tools in its own timeline. */
  const provenLate = (conversationId: string, afterMs: number): string => {
    const seq = ++proofSeq;
    const requestId = `wfr_block_late_${seq}`;
    setTimeout(() => {
      observeRequestCorrelation({
        requestId,
        conversationId,
        sessionId: 'session-blocked-chats',
        messageId: `message-block-${seq}`,
        tool: 'read',
        observedAt: Date.now()
      });
    }, afterMs).unref?.();
    return requestId;
  };

  const readAs = (requestId: string | null, virtualPath = '/workspace/notes.txt'): Promise<any> =>
    modern(
      'tools/call',
      { name: 'read', arguments: { paths: [virtualPath] } },
      requestId ? { 'x-request-id': `${requestId}/att1` } : {}
    );

  beforeEach(() => {
    resetBlockedChatsForTests();
    resetTrustedChatsForTests();
    resetAgentsForTests();
    onSwarmPersistNow(async () => undefined);
    onSpawnRequest(() => undefined);
    getConfig().multiAgent.strictChatAllowlist = false;
  });
  afterAll(() => {
    resetBlockedChatsForTests();
    resetTrustedChatsForTests();
    resetAgentsForTests();
    getConfig().multiAgent.strictChatAllowlist = false;
  });

  it('refuses a blocked chat’s call and tells the model to stop instead of retrying', async () => {
    setChatBlocked(ROGUE, true);
    const reply = await readAs(owned(ROGUE));
    const text = textOf(reply);

    expect(failed(reply)).toBe(true);
    expect(text).toContain('CHAT_BLOCKED');
    // The refusal has to end the turn, so it must forbid the retry loop a bare error invites and name the one action that finishes.
    expect(text).toMatch(/no further tool calls/i);
    expect(text).toMatch(/final answer/i);
    // And no work may have happened behind it: the refusal is the whole result.
    expect(text).not.toContain('/workspace/notes.txt');
  });

  it('blocks every tool the chat has, not only the one it was blocked during', async () => {
    mcpHarness.ctx.caps = withCaps({ command: true, create: true, edit: true });
    mcpHarness.ctx.readOnly = false;
    setChatBlocked(ROGUE, true);

    for (const call of [
      { name: 'read', arguments: { paths: ['/workspace/notes.txt'] } },
      { name: 'exec_command', arguments: { cmd: 'echo rogue', workdir: '/workspace' } },
      { name: 'apply_patch', arguments: { patch: addPatch('/workspace/blocked.txt', ['nope']) } }
    ]) {
      const reply = await modern('tools/call', call, { 'x-request-id': `${owned(ROGUE)}/att1` });
      expect(textOf(reply), call.name).toContain('CHAT_BLOCKED');
    }
    // apply_patch was refused before it ran, not after it wrote.
    await expect(fs.access(path.join(mcpHarness.approved, 'blocked.txt'))).rejects.toThrow();
  });

  it('never touches another chat, or a call it cannot place at all', async () => {
    setChatBlocked(ROGUE, true);

    const other = await readAs(owned(BYSTANDER));
    expect(failed(other)).toBe(false);
    expect(textOf(other)).toContain('/workspace/notes.txt');

    // No proof, no conversation, no block. Refusing here would punish an unrelated chat — or a phone — for a turn this app cannot even show was theirs.
    const unproven = await readAs(null);
    expect(failed(unproven)).toBe(false);
    expect(textOf(unproven)).toContain('/workspace/notes.txt');
  });

  it('refuses the call whose page evidence proves the blocked chat only after it arrives', async () => {
    setChatBlocked(ROGUE, true);

    const reply = await readAs(provenLate(ROGUE, 40));

    expect(failed(reply)).toBe(true);
    expect(textOf(reply)).toContain('CHAT_BLOCKED');
    // The point of the whole gate: the file was never read, so there is nothing to file under the blocked chat's timeline afterwards.
    expect(textOf(reply)).not.toContain('/workspace/notes.txt');
  });

  it('still lets a call through when the page never proves it at all', async () => {
    setChatBlocked(ROGUE, true);

    // The wait is bounded by the same window attribution uses, and it ends the same way: unproven is unproven. A phone, or a chat with no extension behind it, is not the rogue turn and is not refused for failing to prove it is not.
    const reply = await readAs('wfr_block_never_proven');

    expect(failed(reply)).toBe(false);
    expect(textOf(reply)).toContain('/workspace/notes.txt');
  });

  it('gives the chat its tools back the moment it is released, same request id and all', async () => {
    const requestId = owned(ROGUE);
    setChatBlocked(ROGUE, true);
    expect(textOf(await readAs(requestId))).toContain('CHAT_BLOCKED');

    setChatBlocked(ROGUE, false);
    const after = await readAs(requestId);
    expect(failed(after)).toBe(false);
    expect(textOf(after)).toContain('/workspace/notes.txt');
  });

  it('strict mode refuses untrusted and unattributed calls, then admits only the exact trusted chat', async () => {
    getConfig().multiAgent.strictChatAllowlist = true;

    const untrusted = await readAs(owned(BYSTANDER));
    expect(failed(untrusted)).toBe(true);
    expect(textOf(untrusted)).toContain('CHAT_NOT_TRUSTED');
    expect(textOf(untrusted)).toMatch(/chat list/i);
    expect(textOf(untrusted)).toMatch(/sidebar/i);
    expect(textOf(untrusted)).toContain('Trust');
    expect(textOf(untrusted)).not.toContain('Sessions');
    expect(textOf(untrusted)).not.toContain('/workspace/notes.txt');

    const unattributed = await readAs(null);
    expect(failed(unattributed)).toBe(true);
    expect(textOf(unattributed)).toContain('CHAT_NOT_TRUSTED');

    await setChatTrusted(BYSTANDER, true);
    const trusted = await readAs(owned(BYSTANDER));
    expect(failed(trusted)).toBe(false);
    expect(textOf(trusted)).toContain('/workspace/notes.txt');
  });

  it('strict mode waits for late exact proof and block still wins over trust', async () => {
    getConfig().multiAgent.strictChatAllowlist = true;
    await setChatTrusted(ROGUE, true);

    const trustedLate = await readAs(provenLate(ROGUE, 40));
    expect(failed(trustedLate)).toBe(false);
    expect(textOf(trustedLate)).toContain('/workspace/notes.txt');

    setChatBlocked(ROGUE, true);
    const blocked = await readAs(owned(ROGUE));
    expect(failed(blocked)).toBe(true);
    expect(textOf(blocked)).toContain('CHAT_BLOCKED');
    expect(textOf(blocked)).not.toContain('CHAT_NOT_TRUSTED');
  });

  it('lets a trusted prime worker use tools and revokes it with the prime', async () => {
    const prime = 'strict-prime-owner';
    const worker = 'strict-worker-owned';
    getConfig().multiAgent.strictChatAllowlist = true;
    const run = spawn({ caller: { conversationId: prime }, workers: [{ task: 'read the project' }] });
    expect(bindConversation('worker-1', worker, run.runId)).toBe(true);

    await setChatTrusted(prime, true);
    const allowed = await readAs(owned(worker));
    expect(failed(allowed), textOf(allowed)).toBe(false);
    expect(textOf(allowed)).toContain('/workspace/notes.txt');

    await setChatTrusted(prime, false);
    const untrusted = await readAs(owned(worker));
    expect(failed(untrusted)).toBe(true);
    expect(textOf(untrusted)).toContain('CHAT_NOT_TRUSTED');

    await setChatTrusted(prime, true);
    setChatBlocked(prime, true);
    const parentBlocked = await readAs(owned(worker));
    expect(failed(parentBlocked)).toBe(true);
    expect(textOf(parentBlocked)).toContain('CHAT_NOT_TRUSTED');
  });

  it('tells a refused worker to use the owning prime row in the sidebar', async () => {
    const prime = 'strict-worker-notice-prime';
    const worker = 'strict-worker-notice-child';
    const primeSession = await createSession({ title: 'strict worker notice prime', conversationId: prime });
    const workerSession = await createSession({
      title: 'strict worker notice child', conversationId: worker,
      origin: { kind: 'worker', fromSessionId: primeSession.id, agentId: 'worker-1', task: 'read the project' }
    });
    getConfig().multiAgent.strictChatAllowlist = true;
    const run = spawn({ caller: { conversationId: prime }, workers: [{ task: 'read the project' }] });
    expect(bindConversation('worker-1', worker, run.runId)).toBe(true);

    const refused = await readAs(ownedSession(worker, workerSession.id));
    expect(failed(refused)).toBe(true);
    const notices = (await readRecentEvents(workerSession.id, 20))
      .filter(event => event.kind === 'progress' && /owning prime/i.test(event.message.text));
    expect(notices).toHaveLength(1);
    const copy = notices[0]?.kind === 'progress' ? notices[0].message.text : '';
    expect(copy).toMatch(/owning prime row/i);
    expect(copy).toMatch(/sidebar/i);
    expect(copy).toContain('Trust');
    expect(copy).toContain('Release');
    expect(copy).not.toContain('Sessions');
  });

  it('keeps durable worker identity fail-closed after broker provenance expires', async () => {
    const worker = 'strict-worker-durable-origin';
    const session = await createSession({
      title: 'strict durable worker origin',
      conversationId: worker,
      origin: { kind: 'worker', fromSessionId: null, agentId: 'worker-9', task: 'old worker task' }
    });
    getConfig().multiAgent.strictChatAllowlist = true;
    // Simulate a pre-fix direct worker Trust entry that outlived the broker family's bounded active/dormant/retired retention. Durable session origin must still keep it fail-closed.
    await setChatTrusted(worker, true);

    const refused = await readAs(ownedSession(worker, session.id));
    expect(failed(refused)).toBe(true);
    expect(textOf(refused)).toContain('CHAT_NOT_TRUSTED');
    const notices = (await readRecentEvents(session.id, 20))
      .filter(event => event.kind === 'progress' && /app-created worker/.test(event.message.text));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind === 'progress' && notices[0].message.text).toContain('no unique owning prime');
  });

  it('keeps a trusted chat authorized only after its Compact & Resume successor commits', async () => {
    const chatA = 'f0f00009-1111-4111-8111-111111111111';
    const chatB = 'f0f00010-1111-4111-8111-111111111111';
    const chatC = 'f0f00012-1111-4111-8111-111111111111';
    const summary = await createSession({ title: 'strict resume owner', conversationId: chatA });
    getConfig().multiAgent.strictChatAllowlist = true;
    await setChatTrusted(chatA, true);

    const opened = await openContinuationNow(summary.id, chatA, false);
    expect((await beginContinuationSourceSendNow(opened.token))?.allowed).toBe(true);
    expect(await dispatchContinuationSourceSendNow(opened.token)).toBe(true);
    await attachSummary(opened.token, 'STRICT_RESUME_SUMMARY\n'.repeat(40));
    expect(await claimContinuationNow(opened.token, 'strict-resume-document')).not.toBeNull();

    const beforeCommit = await readAs(ownedSession(chatB, summary.id));
    expect(failed(beforeCommit)).toBe(true);
    expect(textOf(beforeCommit)).toContain('CHAT_NOT_TRUSTED');

    expect(await commitContinuation(opened.token, chatB)).toBe(true);
    const afterCommit = await readAs(ownedSession(chatB, summary.id));
    expect(failed(afterCommit), textOf(afterCommit)).toBe(false);
    expect(textOf(afterCommit)).toContain('/workspace/notes.txt');

    // The durable lineage remains transitive across later committed resumes; B has no copied Trust bit of its own, so C still derives from the original explicit source A.
    expect(await rebindSession(summary.id, chatB, chatC, 'handoff-resume-chain-0001')).toBe(true);
    const afterSecondCommit = await readAs(ownedSession(chatC, summary.id));
    expect(failed(afterSecondCommit), textOf(afterSecondCommit)).toBe(false);
    expect(textOf(afterSecondCommit)).toContain('/workspace/notes.txt');

    await setChatTrusted(chatA, false);
    const revoked = await readAs(ownedSession(chatC, summary.id));
    expect(failed(revoked)).toBe(true);
    expect(textOf(revoked)).toContain('CHAT_NOT_TRUSTED');

    await setChatTrusted(chatA, true);
    setChatBlocked(chatB, true);
    const intermediateBlocked = await readAs(ownedSession(chatC, summary.id));
    expect(failed(intermediateBlocked)).toBe(true);
    expect(textOf(intermediateBlocked)).toContain('CHAT_NOT_TRUSTED');
    setChatBlocked(chatB, false);
    setChatBlocked(chatA, true);
    const sourceBlocked = await readAs(ownedSession(chatC, summary.id));
    expect(failed(sourceBlocked)).toBe(true);
    expect(textOf(sourceBlocked)).toContain('CHAT_NOT_TRUSTED');
  });

  it('records one visible notice when strict mode refuses an attributed untrusted chat', async () => {
    const conversationId = 'f0f00011-1111-4111-8111-111111111111';
    const session = await createSession({ title: 'strict refusal notice', conversationId });
    getConfig().multiAgent.strictChatAllowlist = true;

    const parallel = await Promise.all([
      readAs(ownedSession(conversationId, session.id)),
      readAs(ownedSession(conversationId, session.id))
    ]);
    expect(parallel.every(reply => textOf(reply).includes('CHAT_NOT_TRUSTED'))).toBe(true);
    const notes = (await readRecentEvents(session.id, 20))
      .filter(event => event.kind === 'progress' && /untrusted chat was refused/.test(event.message.text));
    expect(notes).toHaveLength(1);
    const copy = notes[0]?.kind === 'progress' ? notes[0].message.text : '';
    expect(copy).toMatch(/chat list/i);
    expect(copy).toMatch(/hover.*sidebar/i);
    expect(copy).toContain('Trust (✓)');
    expect(copy).not.toContain('Sessions');

    await setChatTrusted(conversationId, true);
    expect(failed(await readAs(ownedSession(conversationId, session.id)))).toBe(false);
    await setChatTrusted(conversationId, false);
    expect(textOf(await readAs(ownedSession(conversationId, session.id)))).toContain('CHAT_NOT_TRUSTED');
    const nextEpisode = foldProgress(await readRecentEvents(session.id, 20))
      .filter(event => event.kind === 'progress' && /untrusted chat was refused/.test(event.message.text));
    expect(nextEpisode).toHaveLength(2);
  });
});
