import {
  fixture,
  binding,
  automate,
  changed,
  sessionId,
  input,
  seedLegacyInput,
  offerToolInput,
} from './input-context.js';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  fileSilenceInput,
  deferSilenceInput,
  revokeSilenceInputs,
  pendingQueuedPickups,
  acknowledgeBrowserInput,
  cancelInput,
  claimBrowserInput,
  enqueueInput,
  failBrowserInput,
  listInputs,
  pendingBrowserInputs,
  resetInputForTests,
  configureInputDelivery,
  editQueuedInput,
  authorizeBrowserInput,
  sessionInputPolicy,
} from '../../backend/domains/sessions/input/input.js';
import type { InputArgs, InputEntry } from '../../backend/domains/sessions/input/input.js';
import { stageInputAttachment } from '../../backend/domains/sessions/input/attachments/index.js';
import { turnHasMcpCall } from '../../backend/domains/sessions/history/store.js';

describe('one silence delivery for a correction and its next checkpoint', () => {
  async function stagedImage() {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#888888' } }).png().toBuffer();
    return stageInputAttachment({ name: 'shape.png', bytes }, new Set());
  }
  it.each(['text', 'image'] as const)('keeps %s injection on the exact MCP grant after a native completed event', async kind => {
    binding.model = 'gpt-6-pro'; binding.finishEnabled = false;
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'retained-mcp-turn', time: fixture.now, seq: 12 };
    configureInputDelivery({ applyAutomation: automate, changed,
      activity: () => ({ possible: true, exact: true, turnId: 'retained-mcp-turn', model: 'pro' }) });
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: true, injectionTurnId: 'retained-mcp-turn', settled: false, browserAllowed: false });
    const image = kind === 'image' ? await stagedImage() : null;
    const correction = await enqueueInput(input({ delivery: 'tool', ...(image ? { attachments: [image] } : {}) }));
    expect(correction.transportIntent).toBe('tool');
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'continued-exact-call', fixture.now)).toEqual([
      expect.objectContaining({ text: correction.text, images: image ? [expect.objectContaining({ dataUrl: expect.stringMatching(/^data:image\/webp;base64,/) })] : [] })
    ]);
  });

  it('rejects an image preparation whose retained exact turn changed during normalization', async () => {
    binding.model = 'gpt-6-pro'; binding.finishEnabled = false;
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'retained-mcp-turn', time: fixture.now, seq: 12 };
    let observations = 0;
    configureInputDelivery({ applyAutomation: automate, changed,
      activity: () => ({ possible: true, exact: true, turnId: ++observations === 1 ? 'retained-mcp-turn' : 'replacement-turn', model: 'pro' }) });
    const image = await stagedImage();
    await expect(enqueueInput(input({ attachments: [image], attachmentDelivery: 'tool' })))
      .rejects.toThrow('active chat changed while preparing images');
    expect(await listInputs()).toEqual([]);
  });

  async function bundle(manual: Partial<InputArgs> = {}, checkpoint: Partial<InputArgs> = {}) {
    binding.model = 'gpt-6-pro'; binding.finishEnabled = false;
    binding.activeTurnId = 'silent-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'silent-turn', time: fixture.now, seq: 12 };
    const head = await seedLegacyInput(input({ mode: 'after-turn', text: 'Check geometry', ...checkpoint }));
    const later = await enqueueInput(input({ mode: 'after-turn', text: 'Later checkpoint' }));
    const correction = await enqueueInput(input({ text: 'Use real 3D shapes', ...manual }));
    const listenUntil = fixture.now + 600_000;
    expect(await fileSilenceInput(sessionId, binding.conversationId, 'silent-turn', () => true, listenUntil)).toBe(true);
    expect(await pendingBrowserInputs()).toEqual([]);
    // Recovery follows the correction's ticket even though the checkpoint came first.
    expect(await pendingQueuedPickups()).toEqual([expect.objectContaining({ sourceTurnId: 'silent-turn', listenUntil })]);
    fixture.now = listenUntil;
    return { head, later, correction };
  }

  it('keeps a picture request together with its queued checkpoint', async () => {
    const { correction } = await bundle({ text: 'Create an image of a red cube' });
    const claim = await claimBrowserInput(correction.id, 'first-page', binding.conversationId, true);
    expect(claim?.text).toBe('Create an image of a red cube\n\nNext queued instruction:\nCheck geometry');
  });

  it('claims only the next checkpoint, restores exact bytes, and records one combined native receipt', async () => {
    const { head, later, correction } = await bundle();
    const history = vi.fn(async (_row: Readonly<InputEntry>) => true);
    configureInputDelivery({ applyAutomation: automate, changed, recordDelivered: history });
    const claim = await claimBrowserInput(correction.id, 'first-page', binding.conversationId, true);
    expect(claim?.text).toBe('Use real 3D shapes\n\nNext queued instruction:\nCheck geometry');
    expect(await claimBrowserInput(head.id, 'other-page', binding.conversationId, true)).toBeNull();
    expect(await editQueuedInput(head.id, 'Racing edit')).toBe(false);
    resetInputForTests();
    const reclaimed = await claimBrowserInput(correction.id, 'replacement-page', binding.conversationId, true);
    expect(reclaimed?.text).toBe(claim?.text);
    expect(await authorizeBrowserInput(correction.id, 'first-page', binding.conversationId)).toBe(false);
    expect(await authorizeBrowserInput(correction.id, 'replacement-page', binding.conversationId)).toBe(true);
    expect(await acknowledgeBrowserInput(head.id, 'replacement-page', binding.conversationId, 'native-id')).toBe(false);
    expect(await acknowledgeBrowserInput(correction.id, 'replacement-page', binding.conversationId, 'native-id')).toBe(true);
    expect(history).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: correction.id, text: claim?.text, messageId: 'native-id' }), expect.any(Function));
    const rows = await listInputs();
    for (const id of [head.id, correction.id]) expect(rows.find(row => row.id === id)).toMatchObject({ state: 'sent', messageId: 'native-id', historyRecorded: true });
    expect(rows.find(row => row.id === later.id)).toMatchObject({ state: 'queued' });
    expect(await enqueueInput(input({ ...correction }))).toMatchObject({ text: 'Use real 3D shapes' });
  });

  it('releases both unsubmitted claims when real work resumes and injects only the correction', async () => {
    const { head, correction } = await bundle();
    await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    await revokeSilenceInputs(sessionId);
    fixture.now += 61_000;
    const rows = await listInputs();
    for (const id of [head.id, correction.id]) expect(rows.find(row => row.id === id)).toMatchObject({ state: 'queued', owner: null });
    expect(rows.find(row => row.id === correction.id)?.companionInputId).toBeUndefined();
    expect(await authorizeBrowserInput(correction.id, 'page', binding.conversationId)).toBe(false);
    expect(await offerToolInput(sessionId, binding.conversationId, 'resumed-call', fixture.now)).toEqual([expect.objectContaining({ text: 'Use real 3D shapes' })]);
  });

  it.each(['cancel', 'failure', 'delay'] as const)('keeps both originals under one late receipt after %s', async outcome => {
    const { head, correction } = await bundle();
    await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    await authorizeBrowserInput(correction.id, 'page', binding.conversationId);
    if (outcome === 'cancel') expect(await cancelInput(head.id)).toBe(true);
    if (outcome === 'failure') expect(await failBrowserInput(correction.id, 'page', 'Lost response after Send')).toBe(true);
    if (outcome === 'delay') fixture.now += 45_001;
    resetInputForTests();
    for (const id of [head.id, correction.id]) expect((await listInputs()).find(row => row.id === id)).toMatchObject({ state: outcome === 'delay' ? 'browser' : 'cancelled' });
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(correction.id, 'replacement-page', binding.conversationId, true)).toBeNull();
    expect(await acknowledgeBrowserInput(correction.id, 'page', binding.conversationId, 'late-native-id')).toBe(true);
    for (const id of [head.id, correction.id]) expect((await listInputs()).find(row => row.id === id)).toMatchObject({ state: outcome === 'delay' ? 'sent' : 'cancelled', messageId: 'late-native-id' });
  });

  it('preserves authorized bundle custody against a fresh-work revocation and false safe-withdrawal report', async () => {
    const { head, correction } = await bundle();
    await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    await authorizeBrowserInput(correction.id, 'page', binding.conversationId);
    await revokeSilenceInputs(sessionId);
    expect((await listInputs()).filter(row => row.state === 'browser')).toHaveLength(2);
    await failBrowserInput(correction.id, 'page', 'After-turn pickup was withdrawn before Send.');
    expect((await listInputs()).find(row => row.id === head.id)?.state).toBe('cancelled');
    expect(await offerToolInput(sessionId, binding.conversationId, 'resumed', fixture.now)).toEqual([]);
  });

  it('reserves both rows before a failing automation transition can publish either claim', async () => {
    const { head, correction } = await bundle({ automation: 'off' });
    automate.mockRejectedValueOnce(new Error('Control persistence failed'));
    await expect(claimBrowserInput(correction.id, 'page', binding.conversationId, true)).rejects.toThrow('Control persistence failed');
    resetInputForTests();
    for (const id of [head.id, correction.id]) expect((await listInputs()).find(row => row.id === id)?.state).toBe('failed');
    expect(await pendingBrowserInputs()).toEqual([]);
  });

  it('preserves the file preparation timeout when only the checkpoint has a native attachment', async () => {
    const file = { id: randomUUID(), name: 'shape.stl', mimeType: 'application/octet-stream', size: 42 };
    const { head, correction } = await bundle({}, { attachments: [file] });
    const claim = await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    expect(claim?.attachments).toEqual([file]);
    fixture.now += 120_001;
    resetInputForTests();
    for (const id of [head.id, correction.id]) expect((await listInputs()).find(row => row.id === id)?.state).toBe('browser');
    fixture.now += 600_000;
    for (const id of [head.id, correction.id]) expect((await listInputs()).find(row => row.id === id)?.state).toBe('cancelled');
  });

  it.each(['text', 'images'] as const)('sends the correction alone if the optional checkpoint would exceed the %s bound', async kind => {
    const image = { name: 'shape.webp', dataUrl: 'data:image/webp;base64,AAAA' };
    const { head, correction } = kind === 'text'
      ? await bundle({ text: 'x'.repeat(90_000) }, { text: 'y'.repeat(10_000) })
      : await bundle({ images: Array(10).fill(image) }, { images: [image] });
    const claim = await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    expect(claim?.text).toBe(correction.text);
    expect(claim?.companionInputId).toBeUndefined();
    expect((await listInputs()).find(row => row.id === head.id)?.state).toBe('queued');
  });

  it('lets failed-turn correction bypass the initial five-minute wait while retaining a native-busy five-minute deferral', async () => {
    binding.model = 'gpt-6-pro'; binding.finishEnabled = false;
    binding.activeTurnId = 'failed-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'failed-turn', time: fixture.now, seq: 12 };
    const checkpoint = await enqueueInput(input({ mode: 'after-turn', text: 'Wait for automatic pickup' }));
    const correction = await enqueueInput(input());
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-turn', time: fixture.now, seq: 13 };
    await fileSilenceInput(sessionId, binding.conversationId, 'failed-turn', () => true, fixture.now + 300_000);
    expect(await pendingBrowserInputs()).toHaveLength(1);
    const immediate = await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    expect(immediate?.text).toBe(correction.text);
    expect(immediate?.companionInputId).toBeUndefined();
    expect((await listInputs()).find(row => row.id === checkpoint.id)?.state).toBe('queued');
    await failBrowserInput(correction.id, 'page', 'After-turn pickup was withdrawn before Send.');
    expect(await deferSilenceInput(correction.id, binding.conversationId, 'failed-turn')).toBe(true);
    expect(await pendingBrowserInputs()).toEqual([]);
    fixture.now += 299_999;
    expect(await pendingBrowserInputs()).toEqual([]);
    fixture.now += 1;
    expect(await pendingBrowserInputs()).toHaveLength(1);
  });

  it('retains immediate user intent for native files converted from Auto without injecting or advancing a checkpoint', async () => {
    binding.model = 'gpt-6-pro'; binding.finishEnabled = false;
    binding.activeTurnId = 'failed-files';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'failed-files', time: fixture.now, seq: 12 };
    const file = await stageInputAttachment({ text: 'Native file correction' }, new Set());
    const checkpoint = await enqueueInput(input({ mode: 'after-turn', text: 'Automatic checkpoint' }));
    const correction = await enqueueInput(input({ text: 'Read this correction', attachments: [file] }));
    expect(correction).toMatchObject({ mode: 'after-turn', requestedMode: 'auto', transportIntent: 'browser' });
    expect(await offerToolInput(sessionId, binding.conversationId, 'running-call', fixture.now)).toEqual([]);
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-files', time: fixture.now, seq: 13 };
    await fileSilenceInput(sessionId, binding.conversationId, 'failed-files', () => true, fixture.now + 300_000);
    const claim = await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    expect(claim).toMatchObject({ text: 'Read this correction', attachments: [file] });
    expect(claim?.companionInputId).toBeUndefined();
    expect(await authorizeBrowserInput(correction.id, 'page', binding.conversationId)).toBe(true);
    expect((await listInputs()).find(row => row.id === checkpoint.id)?.state).toBe('queued');
  });

  it('retains native-busy waiting and its companion when a completed event arrives during the delay', async () => {
    const { correction, head } = await bundle();
    expect(await deferSilenceInput(correction.id, binding.conversationId, 'silent-turn')).toBe(true);
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'silent-turn', time: fixture.now, seq: 13 };
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await pendingQueuedPickups()).toEqual([expect.objectContaining({ listenUntil: fixture.now + 300_000 })]);
    fixture.now += 299_999;
    expect(await claimBrowserInput(correction.id, 'page', binding.conversationId, true)).toBeNull();
    fixture.now += 1;
    const claim = await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    expect(claim?.companionInputId).toBe(head.id);
    expect(claim?.text).toContain(head.text);
  });

  it('defers the first failed-view manual send before refresh without MCP proof or an automatic checkpoint', async () => {
    binding.model = 'gpt-6-pro'; binding.finishEnabled = false;
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-before-refresh', time: fixture.now, seq: 12 };
    vi.mocked(turnHasMcpCall).mockResolvedValue(false);
    try {
      const checkpoint = await enqueueInput(input({ mode: 'after-turn', text: 'Automatic checkpoint' }));
      const correction = await enqueueInput(input({ text: 'Immediate correction' }));
      expect(correction.transportIntent).toBe('browser');
      expect(correction.silenceBoundary).toBeUndefined();
      expect(await pendingBrowserInputs()).toEqual([expect.objectContaining({ id: correction.id, silenceTurnId: 'failed-before-refresh' })]);
      expect(await deferSilenceInput(correction.id, binding.conversationId, 'wrong-turn')).toBe(false);
      expect(await deferSilenceInput(correction.id, 'wrong-conversation', 'failed-before-refresh')).toBe(false);
      expect(await deferSilenceInput(correction.id, binding.conversationId, 'failed-before-refresh')).toBe(true);
      fixture.now += 60_001;
      resetInputForTests();
      expect((await listInputs()).find(row => row.id === correction.id)?.state).toBe('queued');
      expect(await pendingBrowserInputs()).toEqual([]);
      fixture.now += 239_999;
      const claim = await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
      expect(claim?.text).toBe(correction.text);
      expect(claim?.companionInputId).toBeUndefined();
      expect((await listInputs()).find(row => row.id === checkpoint.id)?.state).toBe('queued');
    } finally { vi.mocked(turnHasMcpCall).mockResolvedValue(true); }
  });
});

