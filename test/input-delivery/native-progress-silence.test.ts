import {
  APP_VERSION,
  BRIDGE_PROTOCOL,
  attributedMcp,
  bearer,
  bridgePort,
  createSession,
  defaultConfig,
  fs,
  getSession,
  goal,
  input,
  message,
  post,
  providerPage,
  randomUUID,
  rebindSession,
  saveConfig,
  writeDurableNow,
} from './context.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('native progress silence authority', () => {
  const bridge = async () => import('../../backend/domains/browser/bridge.js');
  async function open(model: string, proof: 'none' | 'previous' | 'request' | 'current' = 'current') {
    await saveConfig(defaultConfig());
    const conversationId = randomUUID(), turnId = randomUUID(), questionId = randomUUID();
    const session = await createSession({ title: 'Native progress regression', conversationId });
    if (proof === 'previous') {
      await post('/events', { conversationId, events: [{ kind: 'turn_start', turnId: 'previous', time: Date.now() - 2 }] });
      await attributedMcp(conversationId);
      await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'previous', outcome: 'completed', time: Date.now() - 1 }] });
    }
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model, time: Date.now() },
      { kind: 'user_message', messageId: questionId, text: 'Prepare the PDF', time: Date.now(), authoredNow: true },
      { kind: 'turn_start', turnId, time: Date.now() }
    ] });
    if (proof === 'current') await attributedMcp(conversationId);
    if (proof === 'request') await post('/events', { conversationId, events: [{ kind: 'tool_evidence', turnId, time: Date.now(),
      calls: [{ messageId: randomUUID(), tool: 'read', order: 0, answered: false, requestId: randomUUID() }] }] });
    return { conversationId, turnId, questionId, session, window: model === 'gpt-5.6-pro' ? 600_000 : 120_000 };
  }
  async function repairFor(conversationId: string) {
    await (await bridge()).sweepStaleSwarm(Date.now());
    return (await post('/status', { openConversations: [conversationId] })).body.repairs.find((row: any) => row.conversationId === conversationId);
  }
  async function confirm(conversationId: string, repair: any) {
    expect(repair?.reason).toBe('silence');
    if (repair.requiresClaim) expect((await post('/repairs/claim', { conversationId, token: repair.token })).body.allowed).toBe(true);
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
  }

  /** A rescue that was withdrawn must not stand in for the one the chat still needs. The ticket is cancelled for a good reason — the chat resumed on its own, so typing into it would be noise — but the check that keeps one ticket per turn counted the cancelled row all the same. Watched live on 2026-09-23: a rescue filed at 20:32:35, cancelled fifteen seconds later as "the source received new work", and the same turn broke again two minutes after that. The second rescue was refused on the strength of the first, and the chat sat until its owner typed into it. */
  it('files a second rescue for a turn whose first was cancelled without ever sending', async () => {
    const source = await open('gpt-5.6-sol');
    expect(await input.fileRecoveryInput(source.session.id, source.conversationId, source.turnId, false, () => true)).toBe(true);
    const first = (await input.listInputs()).find(row => row.recovery)!;
    expect(first.silenceBoundary?.turnId).toBe(source.turnId);

    // Withdrawn because the chat carried on by itself — nothing was ever sent.
    expect(await input.cancelInput(first.id)).toBe(true);
    expect((await input.listInputs()).find(row => row.id === first.id)?.state).toBe('cancelled');

    // The same turn breaks again. This is the rescue that used to be refused.
    expect(await input.fileRecoveryInput(source.session.id, source.conversationId, source.turnId, false, () => true),
      'a cancelled ticket still blocked the turn it never answered').toBe(true);
    const live = (await input.listInputs()).filter(row => row.recovery && row.state === 'queued');
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(first.id);
  });

  it('keeps authored queued work ahead of automatic Continue after a committed handoff', async () => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const source = await open('gpt-5.6-sol');
      expect(await input.fileRecoveryInput(source.session.id, source.conversationId, source.turnId, false, () => true)).toBe(true);
      const recovery = (await input.listInputs()).find(row => row.recovery)!;
      expect(await input.claimBrowserInput(recovery.id, 'old-document', source.conversationId, true)).not.toBeNull();
      expect(await input.authorizeBrowserInput(recovery.id, 'old-document', source.conversationId)).toBe(true);
      const queued = await input.enqueueInput({ ...message(source.session.id, 'off'), mode: 'after-turn', text: 'Check the original requirement next.' });
      const destination = randomUUID(), nextTurn = randomUUID();
      expect(await rebindSession(source.session.id, source.conversationId, destination)).toBe(true);
      input.resetInputForTests();
      await post('/events', { conversationId: destination, events: [
        { kind: 'model_selection', model: 'gpt-5.6-sol', time: ++now },
        { kind: 'user_message', messageId: randomUUID(), text: 'Continue the original task', time: now, authoredNow: true },
        { kind: 'turn_start', turnId: nextTurn, time: now }
      ] });
      await attributedMcp(destination);
      expect(await input.fileRecoveryInput(source.session.id, destination, nextTurn, false, () => true)).toBe(false);
      expect((await input.listInputs()).find(row => row.id === queued.id)).toEqual(queued);
      expect((await input.listInputs()).find(row => row.id === recovery.id)?.state).toBe('cancelled');
      await post('/events', { conversationId: destination, events: [
        { kind: 'assistant_message', turnId: nextTurn, messageId: randomUUID(), text: 'The current task is done.', state: 'final', final: true, time: ++now },
        { kind: 'turn_end', turnId: nextTurn, outcome: 'completed', time: ++now }
      ] });
      expect((await input.pendingBrowserInputs()).find(row => row.id === queued.id)).toMatchObject({ conversationId: destination, supersededConversationId: source.conversationId });
      expect(await input.claimBrowserInput(queued.id, 'next-document', destination, true)).toMatchObject({ text: queued.text });
      expect(await input.authorizeBrowserInput(queued.id, 'next-document', destination)).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it.each(['authored', 'foreign', 'unnamed', 'missing-session', 'companion'] as const)(
    'keeps an uncertain %s browser claim through a handoff and restart', async kind => {
      const source = await open('gpt-5.6-sol');
      expect(await input.fileRecoveryInput(source.session.id, source.conversationId, source.turnId, false, () => true)).toBe(true);
      const pending = (await input.listInputs()).find(row => row.recovery)!;
      expect(await input.claimBrowserInput(pending.id, 'retained-owner', source.conversationId, true)).not.toBeNull();
      expect(await input.authorizeBrowserInput(pending.id, 'retained-owner', source.conversationId)).toBe(true);
      const claimed = (await input.listInputs()).find(row => row.id === pending.id)!;
      if (kind === 'authored') { delete claimed.recovery; delete claimed.silenceBoundary; claimed.text = 'An authored browser message'; }
      if (kind === 'foreign') { claimed.conversationId = randomUUID(); claimed.silenceBoundary!.conversationId = claimed.conversationId; }
      if (kind === 'unnamed') claimed.conversationId = null;
      if (kind === 'missing-session') claimed.sessionId = randomUUID();
      if (kind === 'companion') claimed.companionInputId = randomUUID();
      const rows = claimed.companionInputId ? [claimed, { ...claimed, id: claimed.companionInputId,
        companionInputId: undefined, recovery: undefined, silenceBoundary: undefined, text: 'An authored companion' }] : [claimed];
      await writeDurableNow('session-input', rows);
      expect(await rebindSession(source.session.id, source.conversationId, randomUUID())).toBe(true);
      input.resetInputForTests();
      const restored = await input.listInputs();
      expect(restored).toEqual(rows);
      expect(await input.claimBrowserInput(claimed.id, 'replacement-owner', source.conversationId, true)).toBeNull();
    });

  for (const model of ['gpt-5.6-sol', 'gpt-5.6-pro']) {
    it.each([false, true])(`releases only a departed automatic Continue and preserves its exact late receipt (${model}, restored: %s)`, async restored => {
      let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const source = await open(model);
        expect(await input.fileRecoveryInput(source.session.id, source.conversationId, source.turnId, model.endsWith('pro'), () => true)).toBe(true);
        const pending = (await input.listInputs()).find(row => row.sessionId === source.session.id && row.recovery)!;
        expect(await input.claimBrowserInput(pending.id, 'departed-document', source.conversationId, true)).not.toBeNull();
        expect(await input.authorizeBrowserInput(pending.id, 'departed-document', source.conversationId)).toBe(true);
        const authorized = (await input.listInputs()).find(row => row.id === pending.id)!;

        now += 16 * 60_000;
        expect((await input.listInputs()).find(row => row.id === pending.id)).toEqual(authorized);
        expect(await input.fileRecoveryInput(source.session.id, source.conversationId, source.turnId, model.endsWith('pro'), () => true)).toBe(false);
        const destination = randomUUID(), nextTurn = randomUUID();
        expect(await rebindSession(source.session.id, source.conversationId, destination)).toBe(true);
        if (restored) input.resetInputForTests();
        await post('/events', { conversationId: destination, events: [
          { kind: 'model_selection', model, time: ++now },
          { kind: 'user_message', messageId: randomUUID(), text: 'Finish the original task in this chat', time: now, authoredNow: true },
          { kind: 'turn_start', turnId: nextTurn, time: now }
        ] });
        await attributedMcp(destination);
        expect(await input.fileRecoveryInput(source.session.id, destination, nextTurn, model.endsWith('pro'), () => true)).toBe(true);
        const rows = await input.listInputs();
        expect(rows.find(row => row.id === pending.id)).toEqual({ ...authorized, state: 'cancelled' });
        const successor = rows.find(row => row.sessionId === source.session.id && row.state === 'queued')!;
        expect(successor.conversationId).toBe(destination);
        expect(await input.claimBrowserInput(successor.id, 'successor-document', destination, true)).not.toBeNull();
        expect(await input.claimBrowserInput(pending.id, 'new-document', destination, true)).toBeNull();
        expect(await input.acknowledgeBrowserInput(pending.id, 'wrong-document', source.conversationId, 'late-confirmation')).toBe(false);
        expect(await input.acknowledgeBrowserInput(pending.id, 'departed-document', destination, 'late-confirmation')).toBe(false);
        expect(await input.acknowledgeBrowserInput(pending.id, 'departed-document', source.conversationId, 'late-confirmation')).toBe(true);
        expect((await input.listInputs()).find(row => row.id === pending.id)).toMatchObject({
          state: 'cancelled', conversationId: source.conversationId, owner: authorized.owner,
          sendAuthorizedAt: authorized.sendAuthorizedAt, messageId: 'late-confirmation', deliveredSessionId: source.session.id
        });
        expect((await getSession(source.session.id))?.conversationId).toBe(destination);
      } finally { clock.mockRestore(); }
    });

    it.each(['none', 'previous', 'request'] as const)(`never intervenes in ${model} without current-turn MCP (%s)`, async proof => {
      let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const source = await open(model, proof);
        await post('/events', { conversationId: source.conversationId, events: [
          { kind: 'page_tool', turnId: source.turnId, messageId: 'native-search', text: 'Searched 10 websites', time: ++now }
        ] });
        now += source.window + 60_000;
        expect(await repairFor(source.conversationId)).toBeUndefined();
        expect((await input.listInputs()).filter(row => row.sessionId === source.session.id && row.recovery)).toEqual([]);
        expect(await input.fileRecoveryInput(source.session.id, source.conversationId, source.turnId, model.endsWith('pro'), () => true)).toBe(false);
      } finally { clock.mockRestore(); }
    });

    it.each(['page_tool', 'assistant_message'] as const)(`renews ${model} silence from fresh %s but not its replay`, async kind => {
      let now = Date.now(); const began = now, clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const source = await open(model);
        now += source.window - 20_000;
        const activity = { kind, turnId: source.turnId, messageId: 'native-progress', text: 'Prepared PDF',
          state: 'streaming', activeNow: true, time: now };
        await post('/events', { conversationId: source.conversationId, events: [activity] });
        const due = now + source.window;
        const controls = await (await bridge()).sessionControlsFor(source.session.id);
        expect(controls.recovery).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'silence', deadline: due })]));
        now = began + source.window + 1;
        expect(await repairFor(source.conversationId)).toBeUndefined();
        // A reload can change labels while preserving native row identity.
        await post('/events', { conversationId: source.conversationId, events: [{ ...activity, time: now,
          ...(kind === 'page_tool' ? { text: 'Inspected PDF' } : {}) }] });
        now = due - 1;
        expect(await repairFor(source.conversationId)).toBeUndefined();
        now++;
        expect((await repairFor(source.conversationId))?.reason).toBe('silence');
      } finally { clock.mockRestore(); }
    });
  }

  it('keeps a single ticket through canonical user/prose and native-label revisions', async () => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const source = await open('gpt-5.6-sol');
      const progress = { kind: 'page_tool', turnId: source.turnId, messageId: 'stable-native', text: 'Preparing PDF', time: ++now };
      const prose = { kind: 'assistant_message', turnId: source.turnId, messageId: 'interim', text: 'Working on the PDF', state: 'streaming', activeNow: true, time: now };
      await post('/events', { conversationId: source.conversationId, events: [progress, prose] });
      now += source.window + 1;
      await confirm(source.conversationId, await repairFor(source.conversationId));
      const ticket = (await input.listInputs()).find(row => row.sessionId === source.session.id && row.recovery)!;
      expect(ticket).toBeDefined();
      await post('/events', { conversationId: source.conversationId, events: [
        { kind: 'user_message', messageId: source.questionId, turnId: source.questionId, text: 'Prepare the PDF', authoredTime: true, time: now - source.window },
        { ...progress, text: 'Prepared PDF', time: now },
        { ...prose, providerMessageId: randomUUID(), time: now }
      ] });
      input.resetInputForTests();
      expect((await input.listInputs()).find(row => row.id === ticket.id)?.state).toBe('queued');
      now += 60_001;
      await repairFor(source.conversationId);
      expect((await input.listInputs()).filter(row => row.sessionId === source.session.id && row.recovery)).toHaveLength(1);
      expect((await input.claimBrowserInput(ticket.id, 'same-episode', source.conversationId, true))?.id).toBe(ticket.id);
    } finally { clock.mockRestore(); }
  });

  it.each(['page_tool', 'assistant_message'] as const)('keeps the ticket when a previously unseen historical %s is backfilled', async kind => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const source = await open('gpt-5.6-sol');
      now += source.window + 1;
      await confirm(source.conversationId, await repairFor(source.conversationId));
      const ticket = (await input.listInputs()).find(row => row.sessionId === source.session.id && row.recovery)!;
      await post('/events', { conversationId: source.conversationId, events: [{ kind, turnId: source.turnId,
        messageId: 'late-history', text: 'Historical PDF step', state: 'streaming', activeNow: false, time: ++now }] });
      input.resetInputForTests();
      expect((await input.listInputs()).find(row => row.id === ticket.id)?.state).toBe('queued');
      expect((await input.claimBrowserInput(ticket.id, 'unchanged-page', source.conversationId, true))?.id).toBe(ticket.id);
    } finally { clock.mockRestore(); }
  });

  it.each(['queued', 'claimed', 'stop-claimed'] as const)('new native work revokes %s recovery and requires a fresh full window', async phase => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const source = await open('gpt-5.6-sol');
      now += source.window + 1;
      await confirm(source.conversationId, await repairFor(source.conversationId));
      const ticket = (await input.listInputs()).find(row => row.sessionId === source.session.id && row.recovery)!;
      await input.deferSilenceInput(ticket.id, source.conversationId, source.turnId);
      now = ticket.recovery!.busyUntil;
      if (phase !== 'queued') expect(await input.claimBrowserInput(ticket.id, 'resuming-page', source.conversationId, true)).not.toBeNull();
      if (phase === 'stop-claimed') expect(await input.advanceRecoveryInput(ticket.id, 'resuming-page', source.conversationId, 'stop')).toBe(true);
      await post('/events', { conversationId: source.conversationId, events: [{ kind: 'page_tool', turnId: source.turnId,
        messageId: 'new-native-work', text: 'Searched three more websites', activeNow: true, time: ++now }] });
      expect(await input.advanceRecoveryInput(ticket.id, 'resuming-page', source.conversationId, phase === 'stop-claimed' ? 'stopped' : 'stop')).toBe(false);
      expect(await input.authorizeBrowserInput(ticket.id, 'resuming-page', source.conversationId)).toBe(false);
      expect((await input.listInputs()).find(row => row.id === ticket.id)?.state).toBe('cancelled');
      now += source.window - 1;
      expect(await repairFor(source.conversationId)).toBeUndefined();
      now++;
      await confirm(source.conversationId, await repairFor(source.conversationId));
      const episodes = (await input.listInputs()).filter(row => row.sessionId === source.session.id && row.recovery);
      expect(episodes).toHaveLength(2);
      expect(episodes[0]!.recovery!.episode).not.toBe(episodes[1]!.recovery!.episode);
    } finally { clock.mockRestore(); }
  });

  it.each(['stop', 'send'] as const)('withholds %s permission when native work commits during its durable claim write', async action => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let rename: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const source = await open('gpt-5.6-sol');
      now += source.window + 1;
      await confirm(source.conversationId, await repairFor(source.conversationId));
      const ticket = (await input.listInputs()).find(row => row.sessionId === source.session.id && row.recovery)!;
      if (action === 'stop') { await input.deferSilenceInput(ticket.id, source.conversationId, source.turnId); now = ticket.recovery!.busyUntil; }
      expect(await input.claimBrowserInput(ticket.id, 'writing-page', source.conversationId, true)).not.toBeNull();
      const original = fs.rename;
      const { recordChatObservations } = await import('../../backend/domains/sessions/history/recorder.js');
      let injected = false;
      rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (!injected && String(to).endsWith('session-input.json')) {
          injected = true;
          // Simulate the recorder committing while its bridge callback waits on this outbox operation. The final claim check must read durable work.
          await recordChatObservations(source.conversationId, [{ kind: 'page_tool', turnId: source.turnId,
            messageId: 'work-during-write', text: 'Native PDF preparation resumed', activeNow: true, time: ++now }]);
        }
        return original(from, to);
      });
      const attempt = () => action === 'stop'
        ? input.advanceRecoveryInput(ticket.id, 'writing-page', source.conversationId, 'stop')
        : input.authorizeBrowserInput(ticket.id, 'writing-page', source.conversationId);
      expect(await attempt()).toBe(false);
      expect(injected).toBe(true);
      expect(await attempt()).toBe(false);
      const saved = (await input.listInputs()).find(row => row.id === ticket.id)!;
      expect(saved.deliveredAt).toBeUndefined();
      expect(saved.messageId).toBeUndefined();
      if (action === 'send') expect(saved.sendAuthorizedAt).toBeDefined(); // Spent, never reissued.
      else expect(saved.recovery?.phase).toBe('stopping');
    } finally { rename?.mockRestore(); clock.mockRestore(); }
  });

  it('manual Stop supersedes automation interruption and vetoes continuation and reopening after restore', async () => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const source = await open('gpt-5.6-sol');
      await saveConfig({ ...defaultConfig(), multiAgent: { ...defaultConfig().multiAgent, recoverAgentTabs: true } });
      now += source.window + 1;
      await confirm(source.conversationId, await repairFor(source.conversationId));
      const ticket = (await input.listInputs()).find(row => row.sessionId === source.session.id && row.recovery)!;
      await input.deferSilenceInput(ticket.id, source.conversationId, source.turnId); now = ticket.recovery!.busyUntil;
      await input.claimBrowserInput(ticket.id, 'stop-race', source.conversationId, true);
      const claims = await Promise.all([1, 2].map(() => input.advanceRecoveryInput(ticket.id, 'stop-race', source.conversationId, 'stop')));
      expect(claims).toEqual([true, false]);
      await post('/events', { conversationId: source.conversationId, events: [
        { kind: 'turn_end', turnId: source.turnId, outcome: 'interrupted', time: ++now },
        { kind: 'turn_end', turnId: source.turnId, outcome: 'stopped', detail: 'The user pressed native Stop.', time: ++now }
      ] });
      input.resetInputForTests();
      expect((await getSession(source.session.id))?.lastTurnOutcome).toBe('stopped');
      expect(await input.advanceRecoveryInput(ticket.id, 'stop-race', source.conversationId, 'stopped')).toBe(false);
      expect(await input.authorizeBrowserInput(ticket.id, 'stop-race', source.conversationId)).toBe(false);
      await post('/closed', { conversationId: source.conversationId });
      now += 20 * 60_000;
      expect(await repairFor(source.conversationId)).toBeUndefined();
      expect((await input.listInputs()).filter(row => row.sessionId === source.session.id && row.recovery)).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });

  it('does not renew a silence deadline from an error notification', async () => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const source = await open('gpt-5.6-sol');
      now += source.window - 1000;
      await post('/events', { conversationId: source.conversationId, events: [{ kind: 'chat_error', turnId: source.turnId,
        text: 'An informational notification', recoverable: false, time: now }] });
      now += 1000;
      expect((await repairFor(source.conversationId))?.reason).toBe('silence');
    } finally { clock.mockRestore(); }
  });

  it('revokes a handed reload before browser execution when native work resumes', async () => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const source = await open('gpt-5.6-sol');
      now += source.window + 1;
      const repair = await repairFor(source.conversationId);
      expect(repair).toMatchObject({ reason: 'silence', requiresClaim: true });
      await post('/events', { conversationId: source.conversationId, events: [
        { kind: 'page_tool', turnId: source.turnId, messageId: 'late-native', text: 'Inspected PDF rendering', time: ++now }
      ] });
      expect((await post('/repairs/claim', { conversationId: source.conversationId, token: repair.token })).body.allowed).toBe(false);
      await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [source.conversationId] });
      expect((await input.listInputs()).filter(row => row.sessionId === source.session.id && row.recovery)).toEqual([]);
    } finally { clock.mockRestore(); }
  });
});

describe.each(['off', 'goal', 'loop'] as const)('shared automatic Continue (%s)', mode => {
  beforeEach(async () => { await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false } }); });
  async function silent(model: string, advance: (ms: number) => void, reloadDelay = 0, sourceEnd?: 'completed' | 'interrupted' | 'unknown', mcp = true, manualClose = false) {
    const bridge = await import('../../backend/domains/browser/bridge.js');
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Automatic Continue fixture', conversationId });
    if (mode !== 'off') await goal.setGoalSwitchNow(conversationId, mode, true);
    const questionId = randomUUID(), turnId = randomUUID();
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model, reasoningEffort: 'high', time: Date.now() },
      { kind: 'user_message', messageId: questionId, text: 'Finish the requested task', time: Date.now() },
      { kind: 'turn_start', turnId, time: Date.now() }
    ] });
    if (mcp) await attributedMcp(conversationId);
    if (sourceEnd) await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId, outcome: sourceEnd, time: Date.now() }] });
    const openConversations = manualClose ? [] : [conversationId];
    if (manualClose) {
      await post('/closed', { conversationId, manual: true });
      expect((await getSession(session.id))?.browserRecoveryDismissedAt).toBe(Date.now());
      expect((await post('/status', { openConversations })).body.repairs.some((row: any) => row.conversationId === conversationId)).toBe(false);
    }
    const window = model === 'gpt-5.6-pro' ? 600_000 : 120_000;
    advance(window - 1);
    await bridge.sweepStaleSwarm(Date.now());
    expect((await input.pendingBrowserInputs()).filter(row => row.conversationId === conversationId)).toEqual([]);
    advance(2);
    await bridge.sweepStaleSwarm(Date.now());
    if (manualClose) {
      expect((await post('/status', { openConversations })).body.repairs.some((row: any) => row.conversationId === conversationId)).toBe(false);
      expect((await input.listInputs()).filter(row => row.sessionId === session.id && row.recovery)).toEqual([]);
      // Explicitly returning to this page releases the dismissal. Existing work is still overdue, so recovery resumes without another start/tool call.
      const returned = await fetch(`http://127.0.0.1:${bridgePort()}/activity?conversationId=${conversationId}`, {
        headers: { authorization: `Bearer ${bearer}`, 'x-extension-version': APP_VERSION, 'x-extension-protocol': String(BRIDGE_PROTOCOL) }
      });
      expect(returned.status).toBe(200);
      expect((await getSession(session.id))?.browserRecoveryDismissedAt).toBeUndefined();
      openConversations.push(conversationId);
      await bridge.sweepStaleSwarm(Date.now());
    }
    const repair = (await post('/status', { openConversations })).body.repairs.find((row: any) => row.conversationId === conversationId);
    expect(repair?.reason).toBe('silence');
    if (repair.requiresClaim) expect((await post('/repairs/claim', { token: repair.token })).body.allowed).toBe(true);
    advance(reloadDelay);
    await post(`/status?repaired=${repair.token}&repairAction=${manualClose ? 'reopened' : 'reloaded'}`, { openConversations });
    const row = (await input.listInputs()).find(row => row.sessionId === session.id && row.recovery)!;
    expect(row).toMatchObject({ state: 'queued', recovery: { questionId, phase: 'ready' } });
    return { row, conversationId, session, turnId };
  }

  it.each(['gpt-5.6-sol', 'gpt-5.6-pro'])('continues an idle unfinished %s immediately after its initial reload', async model => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { row, conversationId } = await silent(model, ms => { now += ms; });
      expect((await input.pendingBrowserInputs()).find(entry => entry.id === row.id)?.recovery?.stop).toBe(false);
      const claim = await input.claimBrowserInput(row.id, 'idle-doc', conversationId, true);
      expect(claim?.text).toBe(row.text);
      expect(await input.advanceRecoveryInput(row.id, 'idle-doc', conversationId, 'stop')).toBe(false);
      expect(await input.authorizeBrowserInput(row.id, 'idle-doc', conversationId)).toBe(true);
      expect(await input.authorizeBrowserInput(row.id, 'idle-doc', conversationId)).toBe(false);
      expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    } finally { clock.mockRestore(); }
  });

  it.each(['queued', 'claimed', 'authorized'] as const)('hands a late final from %s Continue back to the active driver', async phase => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { row, conversationId, session, turnId } = await silent('gpt-5.6-sol', ms => { now += ms; });
      if (mode !== 'off') await goal.setGoalObjectiveNow(conversationId, 'Finish the remaining implementation');
      const claim = { id: row.id, owner: 'late-final-document', conversationId };
      if (phase !== 'queued') expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input).toBeDefined();
      if (phase === 'authorized') expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
      // The native pre-click check discovers and journals the actual final after the app has granted permission, but before any native Send was attempted.
      const final = { kind: 'assistant_message', messageId: randomUUID(), providerMessageId: randomUUID(), turnId,
        text: 'The first part is ready. The remaining implementation still needs work.',
        state: 'final', final: true, activeNow: true, goalEligible: true, time: ++now };
      expect((await post('/events', { conversationId, events: [final] })).status).toBe(200);
      if (phase === 'authorized') {
        const failure = { ...claim, error: 'After-turn pickup was withdrawn before Send.' };
        expect((await post('/input/fail', { ...failure, owner: 'different-document' })).body.ok).toBe(false);
        expect(await input.inputBeforeGoal(session.id, turnId)).toBe('queued');
        expect((await post('/input/fail', failure)).body.ok).toBe(true);
        expect((await post('/input/fail', failure)).body.ok).toBe(false);
        expect(await input.acknowledgeBrowserInput(row.id, claim.owner, conversationId, 'impossible-receipt')).toBe(false);
        expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'failed', sendAuthorizedAt: expect.any(Number) });
      }
      input.resetInputForTests();
      expect(await input.inputBeforeGoal(session.id, turnId)).toBeNull();
      expect((await input.pendingBrowserInputs()).some(entry => entry.id === row.id)).toBe(false);
      expect(await input.authorizeBrowserInput(row.id, claim.owner, conversationId)).toBe(false);
      if (mode === 'off') expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
      else {
        expect(goal.goalPendingReplyFor(conversationId)?.replyId).toBe(final.messageId);
        now += 60_000;
        providerPage.configureProviderPageForTests({ complete: async () => ({
          text: JSON.stringify({ action: 'continue', reply: 'Finish the remaining implementation and verify it.' })
        }) });
        const result = await post('/goal/draft', { conversationId, turnId, clientId: claim.owner, terminalRequired: true });
        expect(result.status).toBe(200);
        let helper: Awaited<ReturnType<typeof input.listInputs>>[number] | undefined;
        await vi.waitFor(() => expect(goal.goalViewFor(conversationId)?.stage).toBe('ready'));
        await vi.waitFor(async () => {
          helper = (await input.listInputs()).find(entry => entry.purpose === 'decision' && entry.decisionSourceSessionId === session.id);
          expect(helper).toMatchObject({ decisionProvider: expect.any(String), decisionConversationId: expect.any(String), state: 'sent' });
        }, { timeout: 10_000 });
        expect(helper!.text).toContain(final.text);
        expect(goal.goalViewFor(conversationId)?.reply).toBeTruthy();
        expect(goal.goalViewFor(conversationId)?.reply).not.toBe(row.text);
      }
    } finally { clock.mockRestore(); }
  });

  it('keeps an ambiguous Continue exclusive until its exact native receipt arrives', async () => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { row, conversationId, session, turnId } = await silent('gpt-5.6-sol', ms => { now += ms; });
      if (mode !== 'off') await goal.setGoalObjectiveNow(conversationId, 'Finish the remaining implementation');
      expect(await input.claimBrowserInput(row.id, 'uncertain-document', conversationId, true)).not.toBeNull();
      expect(await input.authorizeBrowserInput(row.id, 'uncertain-document', conversationId)).toBe(true);
      await post('/events', { conversationId, events: [{ kind: 'assistant_message',
        messageId: randomUUID(), providerMessageId: randomUUID(), turnId, text: 'The first part is ready.',
        state: 'final', final: true, activeNow: true, goalEligible: true, time: ++now }] });
      input.resetInputForTests();
      expect(await input.inputBeforeGoal(session.id, turnId)).toBe('queued');
      expect(await input.failBrowserInput(row.id, 'uncertain-document', 'The response timed out')).toBe(false);
      expect(await input.inputBeforeGoal(session.id, turnId)).toBe('queued');
      expect(await input.claimBrowserInput(row.id, 'replacement-document', conversationId, true)).toBeNull();
      expect(await input.authorizeBrowserInput(row.id, 'uncertain-document', conversationId)).toBe(false);
      if (mode !== 'off') {
        expect(goal.goalPendingReplyFor(conversationId)).not.toBeNull();
        const result = await post('/goal/draft', { conversationId, turnId, clientId: 'replacement-document', terminalRequired: true });
        expect(result.body.error).toBe('user_input_pending');
      }
      expect(await input.acknowledgeBrowserInput(row.id, 'uncertain-document', conversationId, 'actual-continue-message')).toBe(true);
      expect(await input.inputBeforeGoal(session.id, turnId)).toBe('consumed');
      expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    } finally { clock.mockRestore(); }
  });

  it('gives Pro five full minutes after a delayed reload acknowledgement', async () => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { row, conversationId, turnId } = await silent('gpt-5.6-pro', ms => { now += ms; }, 60_000);
      const deadline = now + 5 * 60_000;
      expect(row.recovery?.busyUntil).toBe(deadline);
      expect(await input.deferSilenceInput(row.id, conversationId, turnId)).toBe(true);
      expect((await input.listInputs()).find(entry => entry.id === row.id)?.silenceBoundary?.listenUntil).toBe(deadline);
    } finally { clock.mockRestore(); }
  });

  it.each(['completed', 'interrupted', 'unknown'] as const)('does not mistake a native %s boundary for a canonical final answer', async outcome => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { row, conversationId } = await silent('gpt-5.6-sol', ms => { now += ms; }, 0, outcome);
      expect(await input.claimBrowserInput(row.id, 'unfinished-doc', conversationId, true)).not.toBeNull();
      expect(await input.authorizeBrowserInput(row.id, 'unfinished-doc', conversationId)).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it('holds Continue during a local tool and cancels it when that source records new work', async () => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const calls = await import('../../backend/infrastructure/tool-gateway/protocol/call-context.js');
    let release: (() => void) | undefined;
    let running: Promise<void> | undefined;
    try {
      const { row, conversationId } = await silent('gpt-5.6-sol', ms => { now += ms; });
      running = calls.trackInFlight({ startedAt: now, transportKey: null, agent: null, outcome: null,
        evidence: calls.emptyEvidence(), caller: { conversationId, requestId: randomUUID(), transportKey: null } },
        () => new Promise<void>(resolve => { release = resolve; }));
      expect(await input.claimBrowserInput(row.id, 'busy-tool-doc', conversationId, true)).toBeNull();
      expect((await input.listInputs()).find(entry => entry.id === row.id)?.state).toBe('queued');
      await attributedMcp(conversationId);
      expect((await input.listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    } finally { release?.(); await running; clock.mockRestore(); }
  });

  it.each(['gpt-5.6-sol', 'gpt-5.6-pro'])('gives busy %s one half-window and fences Stop/reload/Send custody', async model => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { row, conversationId, turnId } = await silent(model, ms => { now += ms; });
      expect(await input.deferSilenceInput(row.id, conversationId, turnId)).toBe(true);
      now = row.recovery!.busyUntil - 1;
      expect((await input.pendingBrowserInputs()).some(entry => entry.id === row.id)).toBe(false);
      now++;
      expect(await input.deferSilenceInput(row.id, conversationId, turnId)).toBe(false);
      expect((await input.pendingBrowserInputs()).find(entry => entry.id === row.id)?.recovery?.stop).toBe(true);
      expect(await input.claimBrowserInput(row.id, 'old-doc', conversationId, true)).not.toBeNull();
      expect(await input.advanceRecoveryInput(row.id, 'other-doc', conversationId, 'stop')).toBe(false);
      expect((await post('/input/claim', { id: row.id, owner: 'old-doc', conversationId, recoveryAction: 'stop' })).body.ok).toBe(true);
      expect(await input.advanceRecoveryInput(row.id, 'old-doc', conversationId, 'stop')).toBe(false);
      await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId, outcome: 'interrupted', time: now }] });
      expect(await input.authorizeBrowserInput(row.id, 'old-doc', conversationId)).toBe(false);
      expect(await input.advanceRecoveryInput(row.id, 'old-doc', conversationId, 'stopped')).toBe(true);
      expect(await input.advanceRecoveryInput(row.id, 'old-doc', conversationId, 'stopped')).toBe(false);
      expect(await input.advanceRecoveryInput(row.id, 'old-doc', conversationId, 'reloaded')).toBe(false);
      expect(await input.claimBrowserInput(row.id, 'other-doc', conversationId, true)).toBeNull();
      expect((await input.claimBrowserInput(row.id, 'old-doc', conversationId, true))?.text).toBe(row.text);
      expect(await input.authorizeBrowserInput(row.id, 'old-doc', conversationId)).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it.each([
    { kind: 'text', manualClose: false }, { kind: 'image', manualClose: false },
    { kind: 'text', manualClose: true }, { kind: 'image', manualClose: true }
  ])('hands a recovered $kind final to Goal/Loop and cancels Continue before Stop (manual close and return: $manualClose)', async ({ kind, manualClose }) => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { row, conversationId, turnId } = await silent('gpt-5.6-sol', ms => { now += ms; }, 0, undefined, true, manualClose);
      expect(await input.deferSilenceInput(row.id, conversationId, turnId)).toBe(true);
      const messageId = randomUUID();
      await post('/events', { conversationId, events: [{ kind: 'assistant_message', messageId,
        providerMessageId: messageId, turnId, text: kind === 'image' ? '' : 'Finished.',
        state: 'final', final: true, goalEligible: true, activeNow: true, time: ++now }] });
      expect(await input.claimBrowserInput(row.id, 'late-doc', conversationId, true)).toBeNull();
      expect((await input.listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
      expect(goal.goalPendingReplyFor(conversationId)?.replyId ?? null).toBe(mode === 'off' ? null : messageId);
    } finally { clock.mockRestore(); }
  });

  it.each(['running', 'settling'] as const)('keeps the same Continue ticket while an unrelated tool is still unassigned (%s)', async phase => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const calls = await import('../../backend/infrastructure/tool-gateway/protocol/call-context.js');
    let release!: () => void;
    let work: Promise<void> | undefined;
    try {
      const { row, conversationId } = await silent('gpt-5.6-pro', ms => { now += ms; });
      const context = { startedAt: now, transportKey: null, agent: null, outcome: null,
        evidence: calls.emptyEvidence(), caller: { conversationId: null as string | null, requestId: randomUUID(), transportKey: null } };
      const pending = new Promise<void>(resolve => { release = resolve; });
      if (phase === 'running') work = calls.trackInFlight(context, () => pending);
      else { calls.holdWhileSettling(context, pending); work = pending; }
      expect((await input.pendingBrowserInputs()).some(entry => entry.id === row.id)).toBe(false);
      expect(await input.claimBrowserInput(row.id, 'held-doc', conversationId, true)).toBeNull();
      input.resetInputForTests();
      expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({
        state: 'queued', owner: null, recovery: row.recovery, silenceBoundary: row.silenceBoundary
      });
      // Exact evidence assigns the tool to a different chat while the call is still live.
      context.caller.conversationId = randomUUID();
      expect((await input.pendingBrowserInputs()).find(entry => entry.id === row.id)).toBeDefined();
      expect(await input.claimBrowserInput(row.id, 'held-doc', conversationId, true)).not.toBeNull();
      expect(await input.authorizeBrowserInput(row.id, 'held-doc', conversationId)).toBe(true);
      expect(await input.authorizeBrowserInput(row.id, 'held-doc', conversationId)).toBe(false);
    } finally { release?.(); await work; clock.mockRestore(); }
  });

  it('retains a claimed Continue across unrelated activity without granting Stop or Send', async () => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const calls = await import('../../backend/infrastructure/tool-gateway/protocol/call-context.js');
    let release!: () => void;
    let work: Promise<void> | undefined;
    try {
      const { row, conversationId, turnId } = await silent('gpt-5.6-pro', ms => { now += ms; });
      expect(await input.deferSilenceInput(row.id, conversationId, turnId)).toBe(true);
      now = row.recovery!.busyUntil;
      expect(await input.claimBrowserInput(row.id, 'claimed-doc', conversationId, true)).not.toBeNull();
      work = calls.trackInFlight({ startedAt: now, transportKey: null, agent: null, outcome: null,
        evidence: calls.emptyEvidence(), caller: { conversationId: null, requestId: randomUUID(), transportKey: null } },
        () => new Promise<void>(resolve => { release = resolve; }));
      expect(await input.advanceRecoveryInput(row.id, 'claimed-doc', conversationId, 'stop')).toBe(false);
      expect(await input.authorizeBrowserInput(row.id, 'claimed-doc', conversationId)).toBe(false);
      expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'browser', owner: 'claimed-doc' });
      release(); await work;
      expect(await input.advanceRecoveryInput(row.id, 'claimed-doc', conversationId, 'stop')).toBe(true);
      expect(await input.advanceRecoveryInput(row.id, 'claimed-doc', conversationId, 'stop')).toBe(false);
      expect(await input.advanceRecoveryInput(row.id, 'claimed-doc', conversationId, 'stopped')).toBe(true);
      expect(await input.authorizeBrowserInput(row.id, 'claimed-doc', conversationId)).toBe(true);
      expect(await input.authorizeBrowserInput(row.id, 'claimed-doc', conversationId)).toBe(false);
    } finally { release?.(); await work; clock.mockRestore(); }
  });

  it.each(['gpt-5.6-sol', 'gpt-5.6-pro'])('keeps Continue and its Stop deadline when reload re-observes the same question with different text (%s)', async model => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { row, conversationId, turnId, session } = await silent(model, ms => { now += ms; });
      const store = await import('../../backend/domains/sessions/history/store.js');
      for (const [index, text] of ['Finish the requested task…', 'Finish the requested task\nwith the existing results.'].entries()) {
        await post('/events', { conversationId, events: [{ kind: 'user_message',
          messageId: row.recovery!.questionId, text, ...(index === 0 ? { authoredNow: false } : {}), time: ++now }] });
        expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({
          state: 'queued', silenceBoundary: { workSeq: row.silenceBoundary!.workSeq },
          recovery: { busyUntil: row.recovery!.busyUntil }
        });
        expect((await store.readLatestUserMessage(session.id))?.message.text).toBe(text);
      }
      expect(await input.deferSilenceInput(row.id, conversationId, turnId)).toBe(true);
      now = row.recovery!.busyUntil - 1;
      expect((await input.pendingBrowserInputs()).some(entry => entry.id === row.id)).toBe(false);
      now++;
      expect((await input.pendingBrowserInputs()).find(entry => entry.id === row.id)?.recovery?.stop).toBe(true);
      expect(await input.claimBrowserInput(row.id, 'reloaded-question-doc', conversationId, true)).not.toBeNull();
      expect(await input.advanceRecoveryInput(row.id, 'reloaded-question-doc', conversationId, 'stop')).toBe(true);
      expect(await input.advanceRecoveryInput(row.id, 'reloaded-question-doc', conversationId, 'stop')).toBe(false);
      expect(await input.authorizeBrowserInput(row.id, 'reloaded-question-doc', conversationId)).toBe(false);
      expect(await input.advanceRecoveryInput(row.id, 'reloaded-question-doc', conversationId, 'stopped')).toBe(true);
      expect(await input.authorizeBrowserInput(row.id, 'reloaded-question-doc', conversationId)).toBe(true);
      expect(await input.authorizeBrowserInput(row.id, 'reloaded-question-doc', conversationId)).toBe(false);
      const nextQuestion = randomUUID(), nextTurn = randomUUID();
      expect(await input.acknowledgeBrowserInput(row.id, 'reloaded-question-doc', conversationId, nextQuestion)).toBe(true);
      expect(await input.acknowledgeBrowserInput(row.id, 'reloaded-question-doc', conversationId, nextQuestion)).toBe(true);
      expect((await input.listInputs()).filter(entry => entry.id === row.id && entry.state === 'sent')).toHaveLength(1);
      await post('/events', { conversationId, events: [
        { kind: 'turn_end', turnId, outcome: 'interrupted', reason: 'automation_silence', time: ++now },
        { kind: 'user_message', messageId: nextQuestion, text: row.text, authoredNow: true, time: ++now },
        { kind: 'turn_start', turnId: nextTurn, time: now }
      ] });
      await attributedMcp(conversationId);
      const bridge = await import('../../backend/domains/browser/bridge.js');
      now += (model === 'gpt-5.6-pro' ? 600_000 : 120_000) - 1;
      await bridge.sweepStaleSwarm(now);
      const pending = () => post('/status', { openConversations: [conversationId] });
      expect((await pending()).body.repairs.some((repair: any) => repair.conversationId === conversationId)).toBe(false);
      now += 2;
      await bridge.sweepStaleSwarm(now);
      const repair = (await pending()).body.repairs.find((repair: any) => repair.conversationId === conversationId);
      expect(repair?.reason).toBe('silence');
      expect((await post('/repairs/claim', { token: repair.token })).body.allowed).toBe(true);
      await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
      const next = (await input.listInputs()).find(entry => entry.sessionId === session.id && entry.state === 'queued' && entry.recovery)!;
      expect(next.id).not.toBe(row.id);
      expect(next.recovery?.questionId).toBe(nextQuestion);
      expect(next.silenceBoundary?.turnId).toBe(nextTurn);
      expect(await input.deferSilenceInput(next.id, conversationId, nextTurn)).toBe(true);
      now = next.recovery!.busyUntil;
      expect((await input.pendingBrowserInputs()).find(entry => entry.id === next.id)?.recovery?.stop).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it('keeps the recovery message and source immutable under user queue operations', async () => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { row, conversationId, session } = await silent('gpt-5.6-sol', ms => { now += ms; });
      expect(await input.editQueuedInput(row.id, 'Replace the automatic recovery with a different task')).toBe(false);
      expect(await input.reorderQueuedInputs(session.id, [row.id])).toBe(false);
      const stored = (await input.listInputs()).find(entry => entry.id === row.id)!;
      expect(stored.text).toBe(row.text);
      expect(stored.silenceBoundary).toEqual(row.silenceBoundary);
      expect(stored.recovery).toEqual(row.recovery);
      expect((await input.claimBrowserInput(row.id, 'unchanged-recovery-doc', conversationId, true))?.text).toBe(row.text);
    } finally { clock.mockRestore(); }
  });

  it.each(['gpt-5.6-sol', 'gpt-5.6-pro', null])('keeps the activity-based Thinking failed deadline and conditional busy wait for %s', async model => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const bridge = await import('../../backend/domains/browser/bridge.js');
      const conversationId = randomUUID(), turnId = randomUUID();
      const session = await createSession({ title: 'Failed response recovery', conversationId });
      if (mode !== 'off') {
        await goal.setGoalSwitchNow(conversationId, mode, true);
        await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, autoContinue: false } });
      }
      await post('/events', { conversationId, events: [
        ...(model ? [{ kind: 'model_selection', model, reasoningEffort: 'high', time: now }] : []),
        { kind: 'user_message', messageId: randomUUID(), text: 'Complete the task', time: now },
        { kind: 'turn_start', turnId, time: now }
      ] });
      await attributedMcp(conversationId);
      const lastWork = now, pro = model === 'gpt-5.6-pro';
      const deadline = lastWork + (pro ? 300_000 : 120_000);
      now += 30_000;
      const failure = { kind: 'turn_end', turnId, outcome: 'failed', reason: 'thinking_failed', time: now };
      await post('/events', { conversationId, events: [failure] });
      const repairFor = async () => (await post('/status', { openConversations: [conversationId] })).body.repairs.find((item: any) => item.conversationId === conversationId);
      expect(await repairFor()).toBeUndefined();
      expect((await bridge.sessionControlsFor(session.id)).recovery).toContainEqual({
        kind: 'silence', deadline, visibleAt: deadline - (pro ? 300_000 : 30_000)
      });
      now = deadline - 1;
      await post('/events', { conversationId, events: [failure] }); // Replayed failure cannot renew or spend silence.
      await bridge.sweepStaleSwarm(now);
      expect(await repairFor()).toBeUndefined();
      now++;
      await bridge.sweepStaleSwarm(now);
      const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((item: any) => item.conversationId === conversationId);
      expect(repair?.reason).toBe('silence');
      expect((await post('/repairs/claim', { token: repair.token })).body.allowed).toBe(true);
      await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
      const row = (await input.listInputs()).find(item => item.sessionId === session.id && item.recovery)!;
      expect(row.recovery!.busyUntil).toBe(now + (pro ? 300_000 : 60_000));
      expect(await input.deferSilenceInput(row.id, conversationId, turnId)).toBe(true);
      expect((await bridge.sessionControlsFor(session.id)).recovery).toContainEqual({
        kind: 'native-busy', deadline: row.recovery!.busyUntil, next: 'continue'
      });
      now = row.recovery!.busyUntil - 1;
      expect((await input.pendingBrowserInputs()).some(item => item.id === row.id)).toBe(false);
      now = row.recovery!.busyUntil;
      expect((await input.pendingBrowserInputs()).find(item => item.id === row.id)?.recovery?.stop).toBe(true);
      expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    } finally { clock.mockRestore(); }
  });

  it('retains the same frozen ticket across restore and stops after the shared 2/5/10 pickup schedule', async () => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const bridge = await import('../../backend/domains/browser/bridge.js');
    try {
      const { row, conversationId } = await silent('gpt-5.6-sol', ms => { now += ms; });
      for (const minutes of [2, 5, 10]) {
        input.resetInputForTests();
        now += minutes * 60_000;
        expect(await input.pendingQueuedPickups()).toEqual(expect.arrayContaining([expect.objectContaining({ conversationId })]));
        await bridge.sweepStaleSwarm(now);
        const status = (await post('/status', { openConversations: [conversationId] })).body;
        const repair = status.repairs.find((item: any) => item.conversationId === conversationId);
        expect(repair?.reason).toBe('goal'); // Existing shared pickup wire reason.
        await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
        expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({ state: 'queued', text: row.text });
        expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
      }
      expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({ pickupRecovery: { attempts: 3, stoppedAt: now } });
      input.resetInputForTests();
      expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({ pickupRecovery: { attempts: 3, stoppedAt: now } });
      now += 15 * 60_000;
      await bridge.sweepStaleSwarm(now);
      expect((await post('/status', { openConversations: [conversationId] })).body.repairs.some((item: any) => item.conversationId === conversationId)).toBe(false);
      expect((await input.listInputs()).find(item => item.id === row.id)?.text).toBe(row.text);
      expect((await input.claimBrowserInput(row.id, 'restored-doc', conversationId, true))?.text).toBe(row.text);
      expect(await input.authorizeBrowserInput(row.id, 'restored-doc', conversationId)).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it.each(['timeout', 'failure'])('releases a pre-send browser %s to the same ticket without replaying Stop', async failure => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { row, conversationId, turnId } = await silent('gpt-5.6-sol', ms => { now += ms; });
      await input.deferSilenceInput(row.id, conversationId, turnId);
      now = row.recovery!.busyUntil;
      await input.claimBrowserInput(row.id, 'lost-doc', conversationId, true);
      expect(await input.advanceRecoveryInput(row.id, 'lost-doc', conversationId, 'stop')).toBe(true);
      if (failure === 'failure') expect(await input.failBrowserInput(row.id, 'lost-doc', 'Page preparation was interrupted')).toBe(true);
      else now += 60_001;
      input.resetInputForTests();
      expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({ state: 'queued', recovery: { phase: 'resumed' } });
      expect(await input.authorizeBrowserInput(row.id, 'lost-doc', conversationId)).toBe(false);
      expect((await input.pendingBrowserInputs()).find(item => item.id === row.id)?.recovery?.stop).toBe(false);
      expect((await input.claimBrowserInput(row.id, 'replacement-doc', conversationId, true))?.text).toBe(row.text);
    } finally { clock.mockRestore(); }
  });

  it.each(['final', 'stop', 'question', 'edited-question', 'activity', 'setting', 'block', 'rebind', 'input'] as const)(
    'cancels a pending recovery on %s before any send or stop', async change => {
      let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const { row, conversationId, session, turnId } = await silent('gpt-5.6-sol', ms => { now += ms; });
        now++;
        if (change === 'final') await post('/events', { conversationId, events: [
          { kind: 'assistant_message', messageId: randomUUID(), turnId, text: 'Finished.', state: 'final', final: true, time: now }
        ] });
        if (change === 'stop') await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId, outcome: 'stopped', time: now }] });
        if (change === 'question') await post('/events', { conversationId, events: [{ kind: 'user_message', messageId: randomUUID(), text: 'A newer instruction', time: now }] });
        if (change === 'edited-question') await post('/events', { conversationId, events: [{ kind: 'user_message',
          messageId: row.recovery!.questionId, text: 'An explicitly authored change', authoredNow: true, time: now }] });
        if (change === 'activity') await attributedMcp(conversationId);
        if (change === 'setting') {
          await goal.setGoalSwitchNow(conversationId, mode === 'off' ? 'goal' : mode, false);
          await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, autoContinue: false } });
        }
        if (change === 'block') (await import('../../backend/domains/sessions/continuity/blocked-chats.js')).setChatBlocked(conversationId, true);
        if (change === 'rebind') await rebindSession(session.id, conversationId, randomUUID());
        if (change === 'input') await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
        expect(await input.claimBrowserInput(row.id, 'late-doc', conversationId, true)).toBeNull();
        const cancelled = (await input.listInputs()).find(entry => entry.id === row.id)!;
        expect(cancelled.state).toBe('cancelled');
        if (change === 'block') expect(cancelled.error).toBe('Automatic Continue cancelled: this chat is blocked.');
        if (change === 'question') expect(cancelled.error).toBe('Automatic Continue cancelled: another user message arrived.');
      } finally { clock.mockRestore(); }
    });
});
