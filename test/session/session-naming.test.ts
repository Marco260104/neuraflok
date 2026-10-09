import {
  clearSessionName,
  closeConversation,
  createSession,
  estimateTokens,
  eventTokens,
  flushSessions,
  fs,
  getSession,
  listSessions,
  liveConversations,
  noteChatOrigin,
  originTitle,
  path,
  readEvents,
  rebindConversation,
  rebindSession,
  recordChatObservations,
  recordToolCall,
  renameSession,
  repairDeterministicAttribution,
  resetRecorderForTests,
  resetSessionStoreForTests,
  sessionForConversation,
  sessionsRoot,
  upsertMessageEvent,
  userTitle,
} from './context.js';
import type {
  SessionEvent,
  SessionOrigin,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------------ naming

/** What a chat this app opened is called. A session is normally named after the first thing said in it, which for a resumed or worker chat is the bootstrap prompt this app typed itself. The installed build's session list was consequently a column of near-identical rows reading `Continue the previous ChatGPT ...` and `You are worker agent "worker-1" in a ...`, with nothing to say which run any of them belonged to. */
describe('naming the chats this app opened', () => {
  const worker: SessionOrigin = {
    kind: 'worker',
    fromSessionId: null,
    agentId: 'worker-1',
    task: 'Port the recorder tests to the new fixture'
  };

  it('names a worker chat for its agent and task', () => {
    expect(originTitle(worker, null)).toBe('worker-1 · Port the recorder tests to the new fixture');
  });

  it('names a resumed chat after the session it continues', () => {
    expect(originTitle({ kind: 'resume', fromSessionId: 's1', agentId: null, task: '' }, 'Fix the bridge')).toBe(
      'Resumed · Fix the bridge'
    );
  });

  // A resumed chat is itself resumable, and a long session is resumed repeatedly.
  it('does not stack the prefix when a resumed chat is resumed again', () => {
    expect(
      originTitle({ kind: 'resume', fromSessionId: 's1', agentId: null, task: '' }, 'Resumed · Fix the bridge')
    ).toBe('Resumed · Fix the bridge');
  });

  it('shortens a task that would otherwise fill the row', () => {
    const long = { ...worker, task: 'x'.repeat(200) };
    expect(originTitle(long, null).length).toBeLessThan(80);
    expect(originTitle(long, null).endsWith('…')).toBe(true);
  });

  it('still names a resume whose source session has been deleted', () => {
    expect(originTitle({ kind: 'resume', fromSessionId: null, agentId: null, task: '' }, null)).toBe(
      'Resumed session'
    );
  });

  /** The ordering that actually happens: the extension acknowledges typing the bootstrap into the fresh tab before that tab has told the app anything about itself, so the origin is known before the session exists. */
  it('keeps desktop chat titles and durable creation provenance without treating them as resumes', async () => {
    const opened = await recordChatObservations('desktop-created', [{ kind: 'user_message', time: Date.now(), text: 'Inspect my project', messageId: 'first-user' }]);
    const before = (await getSession(opened.sessionId!))!.title;
    await noteChatOrigin('desktop-created', { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
    expect((await getSession(opened.sessionId!))?.origin?.kind).toBe('desktop');
    expect((await getSession(opened.sessionId!))?.title).toBe(before);
    expect(originTitle({ kind: 'desktop', fromSessionId: null, agentId: null, task: '' }, before)).toBe(before);
    await noteChatOrigin('desktop-before-recording', { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
    const fresh = await recordChatObservations('desktop-before-recording', [{ kind: 'user_message', time: Date.now(), text: 'Keep my authored title', messageId: 'next-user' }]);
    expect((await getSession(fresh.sessionId!))?.title).toBe('Keep my authored title');
  });

  it('names the session at creation when the origin arrives first', async () => {
    const source = await createSession({ title: 'Fix the bridge' });
    await noteChatOrigin('conv-fresh', {
      kind: 'resume',
      fromSessionId: source.id,
      agentId: null,
      task: ''
    });
    const sessionId = await recordChatObservations('conv-fresh', [
      {
        kind: 'user_message',
        time: Date.now(),
        text: 'Continue the previous NEURAFLOK session. Read the handoff below.',
        messageId: 'boot-1'
      }
    ]);
    const summary = await getSession(sessionId.sessionId!);
    expect(summary?.title).toBe('Resumed · Fix the bridge');
    expect(summary?.origin?.kind).toBe('resume');
    expect(summary?.origin?.fromSessionId).toBe(source.id);
  });

  /** The other ordering: a slow ack, or a page that reported itself unusually fast. */
  it('renames a session that was already created under the bootstrap prompt', async () => {
    const opened = await recordChatObservations('conv-late', [
      {
        kind: 'user_message',
        time: Date.now(),
        text: 'You are worker agent "worker-1" in an NEURAFLOK run.',
        messageId: 'boot-2'
      }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toContain('worker agent');

    await noteChatOrigin('conv-late', worker);
    const summary = await getSession(opened.sessionId!);
    expect(summary?.title).toBe('worker-1 · Port the recorder tests to the new fixture');
    expect(summary?.origin?.agentId).toBe('worker-1');
  });

  /** A worker's bootstrap stays leased until the worker joins, so the same command can be acknowledged more than once. The second ack must not rename a session whose name has since become somebody else's to choose. */
  it('stamps an origin once', async () => {
    const opened = await recordChatObservations('conv-twice', [
      { kind: 'user_message', time: Date.now(), text: 'bootstrap', messageId: 'boot-3' }
    ]);
    await noteChatOrigin('conv-twice', worker);
    await renameSession(opened.sessionId!, 'Renamed by hand');
    await noteChatOrigin('conv-twice', { ...worker, task: 'Something else entirely' });
    expect((await getSession(opened.sessionId!))?.title).toBe('Renamed by hand');
  });

  it('leaves a chat the user started alone', async () => {
    const opened = await recordChatObservations('conv-organic', [
      { kind: 'user_message', time: Date.now(), text: 'why is the bridge flaky', messageId: 'm-1' }
    ]);
    const summary = await getSession(opened.sessionId!);
    expect(summary?.title).toBe('why is the bridge flaky');
    expect(summary?.origin).toBeNull();
  });

  it('promotes only the generic fallback when the first authored user title arrives late', async () => {
    const conversationId = 'conv-late-first-user-title';
    const sessionId = await sessionForConversation(conversationId);
    expect((await getSession(sessionId!))?.title).toBe('New chat');

    const observed = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: 'the real opening question', messageId: 'late-first-user' }
    ]);
    expect(observed.sessionId).toBe(sessionId);
    expect((await getSession(sessionId!))?.title).toBe('the real opening question');

    const manualConversation = 'conv-manual-title-before-user';
    const manualSessionId = await sessionForConversation(manualConversation);
    await renameSession(manualSessionId!, 'My chosen title');
    await recordChatObservations(manualConversation, [
      { kind: 'user_message', time: Date.now(), text: 'must not replace manual title', messageId: 'manual-first-user' }
    ]);
    expect((await getSession(manualSessionId!))?.title).toBe('My chosen title');
  });

  it('promotes the first-user fallback to ChatGPT’s real generated conversation title', async () => {
    const conversationId = 'conv-real-page-title';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: 'bro fix this exact thing please', messageId: 'title-user-1' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('bro fix this exact thing please');

    await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'Fix Local Files Reconstruction' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('Fix Local Files Reconstruction');

    await renameSession(opened.sessionId!, 'My manual title');
    await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'A Later ChatGPT Rename' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('My manual title');
  });

  it('keeps rendered instruction frames out of titles and repairs only their exact recorded fallback', async () => {
    const conversationId = 'conv-rendered-prompt-title';
    const rendered = '[[NEURAL_JAM_CONTEXT:100]]\nGuidance whose Markdown whitespace changed.\n[[/NEURAL_JAM_CONTEXT]]\n\nReal request';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: rendered, messageId: 'framed-title-user' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('New chat');
    await upsertMessageEvent(opened.sessionId!, {
      time: Date.now(), source: 'app', kind: 'user_message', messageId: 'framed-title-user',
      authoredText: 'Real request', message: { text: rendered, chars: rendered.length, truncated: false }
    });
    expect((await getSession(opened.sessionId!))?.title).toBe('Real request');
    await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'Readable generated title' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('Readable generated title');
    await renameSession(opened.sessionId!, 'My title');
    await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'Later generated title' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('My title');
  });

  it.each([80, 120])('promotes a legacy %i-character preview even when title precedes its first message', async length => {
    const text = '  A long authored request '.repeat(12);
    const conversationId = `legacy-preview-${length}`;
    const session = await createSession({ conversationId, title: text.slice(0, length) });
    await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'Generated title' },
      { kind: 'user_message', time: Date.now(), text, messageId: 'legacy-opening' }
    ]);
    expect((await getSession(session.id))?.title).toBe('Generated title');
  });

  it('keeps provider naming authority across receipts, later provider renames and restart', async () => {
    const conversationId = 'provider-title-restart';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'Initial provider title' }
    ]);
    await upsertMessageEvent(opened.sessionId!, { kind: 'user_message', source: 'app', time: Date.now(),
      messageId: 'provider-opening', authoredText: 'Actual request', message: { text: 'wire', chars: 4, truncated: false } });
    expect((await getSession(opened.sessionId!))?.title).toBe('Initial provider title');
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    await recordChatObservations(conversationId, [{ kind: 'conversation_title', time: Date.now(), text: 'Updated provider title' }]);
    expect((await getSession(opened.sessionId!))?.title).toBe('Updated provider title');
    // Even a manual name identical to the preview must stay manual.
    await renameSession(opened.sessionId!, 'Actual request');
    await recordChatObservations(conversationId, [{ kind: 'conversation_title', time: Date.now(), text: 'Must not win' }]);
    expect((await getSession(opened.sessionId!))?.title).toBe('Actual request');
  });

  it('names a chat this app opened after the request, not after ChatGPT\'s title for the instructions', async () => {
    // Live: all 21 app-started chats were called "Coding Agent Instructions" or a variant.
    const conversationId = 'desktop-provider-title';
    await noteChatOrigin(conversationId, { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
    const opened = await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'Coding Agent Instructions' }
    ]);
    await upsertMessageEvent(opened.sessionId!, { kind: 'user_message', source: 'app', time: Date.now(),
      messageId: 'desktop-opening', authoredText: 'Fix the flaky bridge test', message: { text: '[[NEURAL_JAM_CONTEXT:10]]\nwire', chars: 23, truncated: false } });
    expect((await getSession(opened.sessionId!))?.title).toBe('Fix the flaky bridge test');
    await recordChatObservations(conversationId, [{ kind: 'conversation_title', time: Date.now(), text: 'Coding Agent Anleitung' }]);
    expect((await getSession(opened.sessionId!))?.title).toBe('Fix the flaky bridge test');
    await renameSession(opened.sessionId!, 'My own name');
    expect((await getSession(opened.sessionId!))?.title).toBe('My own name');
  });

  it('clears a name back to ChatGPT\'s newest title, also after a restart', async () => {
    const conversationId = 'named-then-cleared';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'First provider title' }
    ]);
    await renameSession(opened.sessionId!, 'My name');
    await recordChatObservations(conversationId, [{ kind: 'conversation_title', time: Date.now(), text: 'Newer provider title' }]);
    let summary = await getSession(opened.sessionId!);
    expect(summary).toMatchObject({ title: 'My name', titleSource: 'manual', autoTitle: { title: 'Newer provider title', source: 'provider' } });
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    expect(await getSession(opened.sessionId!)).toMatchObject({ title: 'My name', autoTitle: { title: 'Newer provider title' } });
    await clearSessionName(opened.sessionId!);
    summary = await getSession(opened.sessionId!);
    expect(summary).toMatchObject({ title: 'Newer provider title', titleSource: 'provider' });
    expect(summary?.autoTitle).toBeUndefined();
    // ChatGPT names it again from here on.
    await recordChatObservations(conversationId, [{ kind: 'conversation_title', time: Date.now(), text: 'Latest provider title' }]);
    expect((await getSession(opened.sessionId!))?.title).toBe('Latest provider title');
  });

  it('clears a name to the title the chat had by its own rules: request, first message or worker task', async () => {
    // A chat this app opened: named by its request, and ChatGPT's instructions title never wins.
    const desktop = 'named-desktop';
    await noteChatOrigin(desktop, { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
    const opened = await recordChatObservations(desktop, [{ kind: 'conversation_title', time: Date.now(), text: 'Coding Agent Instructions' }]);
    await upsertMessageEvent(opened.sessionId!, { kind: 'user_message', source: 'app', time: Date.now(),
      messageId: 'named-desktop-opening', authoredText: 'Fix the flaky bridge test', message: { text: '[[NEURAL_JAM_CONTEXT:10]]\nwire', chars: 23, truncated: false } });
    await renameSession(opened.sessionId!, 'Bridge work');
    await recordChatObservations(desktop, [{ kind: 'conversation_title', time: Date.now(), text: 'Coding Agent Anleitung' }]);
    await clearSessionName(opened.sessionId!);
    expect((await getSession(opened.sessionId!))?.title).toBe('Fix the flaky bridge test');

    // A chat with no title from ChatGPT yet: its first message.
    const plain = await recordChatObservations('named-plain', [
      { kind: 'user_message', time: Date.now(), text: 'why is the bridge flaky', messageId: 'named-plain-1' }
    ]);
    await renameSession(plain.sessionId!, 'Flaky bridge');
    await clearSessionName(plain.sessionId!);
    expect(await getSession(plain.sessionId!)).toMatchObject({ title: 'why is the bridge flaky', titleSource: 'fallback' });

    // A worker: its task title, also when the origin is stamped while it carries a name.
    const work = await recordChatObservations('named-worker', [
      { kind: 'user_message', time: Date.now(), text: 'bootstrap', messageId: 'named-worker-boot' }
    ]);
    await renameSession(work.sessionId!, 'My worker');
    await noteChatOrigin('named-worker', worker);
    expect((await getSession(work.sessionId!))?.title).toBe('My worker');
    await clearSessionName(work.sessionId!);
    expect((await getSession(work.sessionId!))?.title).toBe('worker-1 · Port the recorder tests to the new fixture');
  });

  it('repairs a stored instructions title of an app-opened chat on cold read', async () => {
    const session = await createSession({ conversationId: 'desktop-stored-provider', title: 'Temporary' });
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'app', time: Date.now(),
      messageId: 'desktop-stored-opening', authoredText: 'Plan the release', message: { text: '[[NEURAL_JAM_CONTEXT:10]]\nwire', chars: 23, truncated: false } });
    await flushSessions(); resetSessionStoreForTests();
    const metaPath = path.join(sessionsRoot(), session.id, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    Object.assign(meta, { title: 'Coding Agent Instructions', titleSource: 'provider', origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
    await fs.writeFile(metaPath, JSON.stringify(meta));
    expect((await getSession(session.id))?.title).toBe('Plan the release');
  });

  it('never takes a project page title as the chat name and repairs one already stored', async () => {
    const conversationId = 'project-page-title';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: 'Fix the homelab backup', messageId: 'project-user' }
    ]);
    await recordChatObservations(conversationId, [{ kind: 'conversation_title', time: Date.now(), text: 'ChatGPT - Homelab Development' }]);
    expect((await getSession(opened.sessionId!))?.title).toBe('Fix the homelab backup');
    await recordChatObservations(conversationId, [{ kind: 'conversation_title', time: Date.now(), text: 'Homelab Backup Fix' }]);
    expect((await getSession(opened.sessionId!))?.title).toBe('Homelab Backup Fix');

    // Stored by a build before the filter: repaired on the next cold read.
    const stored = await createSession({ conversationId: 'stored-project-title', title: 'Temporary' });
    await upsertMessageEvent(stored.id, { kind: 'user_message', source: 'app', time: Date.now(),
      messageId: 'stored-project-user', authoredText: 'Plan the NAS migration', message: { text: 'Plan the NAS migration', chars: 22, truncated: false } });
    await flushSessions(); resetSessionStoreForTests();
    const metaPath = path.join(sessionsRoot(), stored.id, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    Object.assign(meta, { title: 'ChatGPT - Homelab Development', titleSource: 'provider' });
    await fs.writeFile(metaPath, JSON.stringify(meta));
    expect((await getSession(stored.id))?.title).toBe('Plan the NAS migration');
  });

  it('hides a leftover Plan helper and names a message-less project page chat after its project', async () => {
    const legacy = async (conversationId: string, patch: Record<string, unknown>) => {
      const session = await createSession({ conversationId, title: 'Temporary' });
      await flushSessions(); resetSessionStoreForTests();
      const metaPath = path.join(sessionsRoot(), session.id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      Object.assign(meta, patch); delete meta.origin;
      await fs.writeFile(metaPath, JSON.stringify(meta));
      return { id: session.id, metaPath };
    };
    const planner = await legacy('legacy-planner', { title: 'You are a task planner, not the executor. Produce 2 to 12 substantial workflow stages', titleSource: 'provider' });
    const project = await legacy('tools-only-project', { title: 'ChatGPT - Homelab Development' });
    const manual = await legacy('manual-project-name', { title: 'ChatGPT - My own name', titleSource: 'manual' });
    // The chat list is read first, as in the app: it must already be repaired, without any of these sessions having been opened.
    const listed = await listSessions();
    expect(listed.map(row => row.id)).not.toContain(planner.id);
    expect(listed.find(row => row.id === project.id)?.title).toBe('Homelab Development');
    expect(listed.find(row => row.id === manual.id)?.title).toBe('ChatGPT - My own name');
    expect((await getSession(planner.id))?.origin?.kind).toBe('helper');
    // Repaired once, on disk: the next cold start serves the fixed labels from the fast path.
    expect(JSON.parse(await fs.readFile(project.metaPath, 'utf8')).title).toBe('Homelab Development');
    expect(JSON.parse(await fs.readFile(planner.metaPath, 'utf8')).origin?.kind).toBe('helper');
    // Hidden, never deleted: the recording stays on disk.
    await expect(fs.stat(planner.metaPath)).resolves.toBeTruthy();
  });

  it('repairs those labels on recordings shaped like the real ones from September', async () => {
    // Real leftovers carry a user message: a Plan helper's is the planner instructions themselves, and an old project page chat has an ordinary request but no stored title source.
    const legacy = async (conversationId: string, message: string, patch: Record<string, unknown>) => {
      const session = await createSession({ conversationId, title: 'Temporary' });
      await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: Date.now(),
        messageId: `${conversationId}-user`, message: { text: message, chars: message.length, truncated: false } });
      await flushSessions(); resetSessionStoreForTests();
      const metaPath = path.join(sessionsRoot(), session.id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      Object.assign(meta, patch); delete meta.origin;
      if (!('titleSource' in patch)) delete meta.titleSource;
      await fs.writeFile(metaPath, JSON.stringify(meta));
      return { id: session.id, metaPath };
    };
    const instructions = 'You are a task planner, not the executor. Produce 2 to 12 substantial workflow stages.';
    const planner = await legacy('sept-planner', instructions, { title: 'You are a task planner, not the executor', titleSource: 'provider' });
    const project = await legacy('sept-project-page', 'Check the desktop and browser automation', { title: 'ChatGPT - Homelab Development' });
    const listed = await listSessions();
    expect(listed.map(row => row.id)).not.toContain(planner.id);
    expect(listed.find(row => row.id === project.id)?.title).toBe('Check the desktop and browser automation');
    expect(JSON.parse(await fs.readFile(planner.metaPath, 'utf8')).origin?.kind).toBe('helper');
    expect(JSON.parse(await fs.readFile(project.metaPath, 'utf8')).title).toBe('Check the desktop and browser automation');
  });

  it('repairs a legacy context preview on cold read using durable authored text', async () => {
    const raw = '[[NEURAL_JAM_CONTEXT:19268]]\nInternal instructions and AGENTS.md '.repeat(3);
    const session = await createSession({ conversationId: 'legacy-context-preview', title: 'Temporary' });
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'app', time: Date.now(),
      messageId: 'context-opening', authoredText: 'Only my request', message: { text: raw, chars: raw.length, truncated: false } });
    await flushSessions(); resetSessionStoreForTests();
    const metaPath = path.join(sessionsRoot(), session.id, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    meta.title = raw.slice(0, 80).trim(); delete meta.titleSource;
    await fs.writeFile(metaPath, JSON.stringify(meta));
    expect((await listSessions()).find(row => row.id === session.id)?.title).toBe('Only my request');
    expect((await getSession(session.id))?.title).toBe('Only my request');
    expect(JSON.parse(await fs.readFile(metaPath, 'utf8')).titleSource).toBe('fallback');
  });

  it('hides a damaged NEURAFLOK continuation frame from automatic titles', () => {
    const damaged = '[[NEURAFLOK-RESUME:abcdefghijklmnop]]\n\n[[NEURAFLOK_CONTEXT:19268]]\nInternal guidance';
    expect(userTitle(damaged)).toBe('');
  });

  it('keeps the complete sent prompt weight when the page later projects only authored user text', async () => {
    const session = await createSession({ conversationId: 'wire-context-weight', title: 'Wire context weight' });
    const authored = 'Inspect the project.';
    const instructions = 'Internal executor guidance. '.repeat(500);
    const wire = `[[NEURAL_JAM_CONTEXT:${instructions.length}]]\n${instructions}\n[[/NEURAL_JAM_CONTEXT]]\n\n${authored}`;
    const wireTokens = estimateTokens(wire);
    await upsertMessageEvent(session.id, {
      kind: 'user_message', source: 'app', time: 100, messageId: 'wire-user', authoredText: authored,
      wireTokenEstimate: wireTokens, message: { text: wire, chars: wire.length, truncated: false }
    });
    const before = (await getSession(session.id))!.contextTokens;
    await upsertMessageEvent(session.id, {
      kind: 'user_message', source: 'extension', time: 101, messageId: 'wire-user',
      message: { text: authored, chars: authored.length, truncated: false }
    });
    const after = (await getSession(session.id))!.contextTokens;
    const [stored] = await readEvents(session.id, { kinds: ['user_message'] });
    expect(after).toBe(before);
    expect(stored).toMatchObject({ kind: 'user_message', authoredText: authored, wireTokenEstimate: wireTokens,
      message: { text: authored } });
    expect(stored && eventTokens(stored)).toBeGreaterThan(estimateTokens(authored));
  });

  it('does not persist native file credentials in recorded artifact arguments', async () => {
    const conversationId = 'conv-artifact-privacy';
    const requestId = 'wfr_artifact_privacy';
    const opened = await recordChatObservations(conversationId, [{
      kind: 'tool_evidence', time: Date.now(), fiberConversationId: conversationId,
      calls: [{ messageId: 'artifact-private', tool: 'download_artifact', order: 0, answered: false, requestId }]
    }]);
    await recordToolCall({ tool: 'download_artifact',
      args: { file: { download_url: 'https://files.oaiusercontent.com/f?sig=PRIVATE_SIGNATURE', file_id: 'file-PRIVATE_ID' }, path: '/project/image.png' },
      content: [{ type: 'text', text: 'Saved /project/image.png.' }], outcome: 'ok', durationMs: 1,
      startedAt: Date.now(), requestId, agent: null });
    const stored = JSON.stringify(await readEvents(opened.sessionId!, { kinds: ['tool_call'] }));
    expect(stored).toContain('native file credentials not stored');
    expect(stored).toContain('/project/image.png');
    expect(stored).not.toContain('PRIVATE_SIGNATURE');
    expect(stored).not.toContain('PRIVATE_ID');
  });

  it('recovers a late worker call agent from the durable worker session origin after live broker state is gone', async () => {
    const conversationId = 'conv-late-worker-call';
    const requestId = 'wfr_late_worker_exact';
    await noteChatOrigin(conversationId, worker);
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: 'worker bootstrap', messageId: 'worker-boot-late-call' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        fiberConversationId: conversationId,
        calls: [{ messageId: 'worker-late-request', tool: 'read', order: 0, answered: false, requestId }]
      }
    ]);
    const originalSessionId = opened.sessionId!;
    await closeConversation(conversationId);
    expect((await getSession(originalSessionId))?.endedAt).not.toBeNull();

    const call = await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/src/main.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 5,
      startedAt: Date.now(),
      requestId,
      // Deliberately contradictory live broker context. Durable request/session epoch wins.
      agent: 'prime'
    });

    expect(call?.conversationId).toBe(conversationId);
    expect(call?.attributionMethod).toBe('request_id');
    const stored = await readEvents(originalSessionId, { kinds: ['tool_call'] });
    expect(stored).toHaveLength(1);
    const recorded = stored[0];
    expect(recorded?.kind === 'tool_call' && recorded.agent).toBe('worker-1');
    expect(recorded?.kind === 'tool_call' && recorded.call.requestId).toBe(requestId);
    // A late request is not evidence that the worker tab or browser conversation reopened.
    expect((await getSession(originalSessionId))?.endedAt).not.toBeNull();
  });

  it('files a retired source chat into its own lineage and refuses its later requests as superseded', async () => {
    const oldConversation = 'conv-worker-before-transfer';
    const newConversation = 'conv-worker-after-transfer';
    const oldRequest = 'wfr_worker_before_transfer';
    const freshRequest = 'wfr_stale_tab_fresh_epoch';
    await noteChatOrigin(oldConversation, worker);
    const original = await recordChatObservations(oldConversation, [
      { kind: 'user_message', time: Date.now(), text: 'worker bootstrap', messageId: 'boot-before-transfer' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        fiberConversationId: oldConversation,
        calls: [{ messageId: 'old-request-message', tool: 'read', order: 0, answered: false, requestId: oldRequest }]
      }
    ]);
    const originalSessionId = original.sessionId!;

    expect(await rebindSession(originalSessionId, oldConversation, newConversation)).toBe(true);
    rebindConversation(originalSessionId, oldConversation, newConversation);

    // The stale old tab is a retired frontend of the one session, never a chat of its own: its prose files into the lineage (2026-09-02: the brief's late re-render minted a session holding nothing but the summary) and it moves none of the projections B now owns.
    const stale = await recordChatObservations(oldConversation, [
      { kind: 'user_message', time: Date.now(), text: 'stale tab carried on', messageId: 'stale-epoch-user' },
      { kind: 'turn_start', time: Date.now(), turnId: 'g-stale-tab-turn' }
    ]);
    expect(stale.sessionId).toBe(originalSessionId);
    expect(stale.activity).toEqual({ meaningful: false, working: false, terminal: false });
    expect(
      (await readEvents(originalSessionId, { kinds: ['user_message'] })).some(
        (event) => event.kind === 'user_message' && event.messageId === 'stale-epoch-user'
      )
    ).toBe(true);
    expect(await readEvents(originalSessionId, { kinds: ['turn_start'] })).toEqual([]);
    expect((await getSession(originalSessionId))?.conversationId).toBe(newConversation);
    expect((await listSessions()).filter((entry) => entry.chatIds.includes(oldConversation))).toHaveLength(1);

    // Exact proof preserves forensic identity, but it is not execution authority after A was replaced. The call stays out of B's live history.
    await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/old.ts'] },
      content: [{ type: 'text', text: 'old request completed late' }],
      outcome: 'ok',
      durationMs: 10,
      startedAt: Date.now(),
      requestId: oldRequest,
      agent: 'prime'
    });
    const originalCalls = await readEvents(originalSessionId, { kinds: ['tool_call'] });
    expect(originalCalls).toHaveLength(0);
    const buckets = (await listSessions()).filter((entry) => entry.title === 'Unattributed activity');
    let isolated: Extract<SessionEvent, { kind: 'tool_call' }> | undefined;
    let isolatedBucketId = '';
    for (const bucket of buckets) {
      const calls = await readEvents(bucket.id, { kinds: ['tool_call'] });
      const match = calls.find(
        (event): event is Extract<SessionEvent, { kind: 'tool_call' }> =>
          event.kind === 'tool_call' && event.call.requestId === oldRequest
      );
      if (!match) continue;
      isolated = match;
      isolatedBucketId = bucket.id;
      break;
    }
    expect(isolated?.call.attributionMethod).toBe('superseded');
    await repairDeterministicAttribution();
    expect(
      (await readEvents(isolatedBucketId, { kinds: ['tool_call'] })).some(
        (event) => event.kind === 'tool_call' && event.call.requestId === oldRequest
      )
    ).toBe(true);

    // A request first proved in the stale tab after the move is still the retired chat's, so it is refused as superseded — a message that names the handover — instead of waiting out the identity window as nobody's. It lands beside the late one, never in the lineage.
    await recordChatObservations(oldConversation, [
      {
        kind: 'tool_evidence',
        time: Date.now(),
        fiberConversationId: oldConversation,
        calls: [{ messageId: 'fresh-request-message', tool: 'read', order: 0, answered: false, requestId: freshRequest }]
      }
    ]);
    await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/fresh.ts'] },
      content: [{ type: 'text', text: 'fresh request' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      requestId: freshRequest,
      agent: null
    });
    expect(await readEvents(originalSessionId, { kinds: ['tool_call'] })).toHaveLength(0);
    const fresh = (await readEvents(isolatedBucketId, { kinds: ['tool_call'] })).find(
      (event) => event.kind === 'tool_call' && event.call.requestId === freshRequest
    );
    expect(fresh?.kind === 'tool_call' && fresh.call.attributionMethod).toBe('superseded');
    expect((await listSessions()).filter((entry) => entry.chatIds.includes(oldConversation))).toHaveLength(1);
  });

  it('does not publish or return stale A→S first-sight state after S durably rebinds to B', async () => {
    const oldConversation = `conv-init-old-${Date.now()}`;
    const newConversation = `conv-init-new-${Date.now()}`;
    const summary = await createSession({ conversationId: oldConversation, title: 'racing restore' });

    const realOpen = fs.open.bind(fs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedRead!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedRead = resolve;
    });
    let paused = false;
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(
      (async (target: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
        if (!paused && String(target) === path.join(sessionsRoot(), summary.id, 'events.jsonl')) {
          paused = true;
          reachedRead();
          await gate;
        }
        return (realOpen as (...callArgs: unknown[]) => ReturnType<typeof fs.open>)(target, ...args);
      }) as typeof fs.open
    );

    try {
      const staleInitialization = sessionForConversation(oldConversation);
      await reached;

      expect(await rebindSession(summary.id, oldConversation, newConversation)).toBe(true);
      rebindConversation(summary.id, oldConversation, newConversation);
      release();

      expect(await staleInitialization).toBeNull();
      expect((await getSession(summary.id))?.conversationId).toBe(newConversation);
      expect(liveConversations().find((entry) => entry.conversationId === oldConversation)).toBeUndefined();
      expect(liveConversations().find((entry) => entry.conversationId === newConversation)?.sessionId).toBe(summary.id);
    } finally {
      release();
      openSpy.mockRestore();
    }
  });
});
