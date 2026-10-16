import {
  IS_WINDOWS,
  MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION,
  UNATTENDED_EXEC_NOTICE_MS,
  abortContinuation,
  attachSummary,
  backdateExecAttendanceForTests,
  backgroundExecObligations,
  beginContinuationSourceSendNow,
  createSession,
  dispatchContinuationSourceSendNow,
  execOwner,
  failed,
  forgetExecOwner,
  fs,
  modern,
  noteExecOwner,
  observeRequestCorrelation,
  openContinuationNow,
  path,
  rebindSession,
  resetContinuationsForTests,
  resetExecOwnershipForTests,
  textOf,
  unifiedExecManager,
  withCaps,
} from './context.js';
import { mcpHarness } from './context.js';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

describe('exec sessions belong to the chat that opened them', () => {
  beforeEach(() => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ command: true });
    // `session status` lists the running commands, which is the other place one chat could learn another's session ids.
    mcpHarness.ctx.sessionTools = true;
    // Ownership is process-global with no natural lifetime boundary, and clearing it can only make the guard more permissive — never the other way round.
    resetExecOwnershipForTests();
  });

  /** What the page reports once it has seen this connector request leave a given chat. */
  const prove = (
    requestId: string,
    conversationId: string,
    sessionId = `session-${conversationId}`
  ) =>
    observeRequestCorrelation({
      requestId,
      conversationId,
      sessionId,
      messageId: `msg-${requestId}`,
      tool: 'exec_command',
      observedAt: Date.now()
    });

  /** A tools/call with the request id supplied by its browser caller. */
  const asChat = (requestId: string | null, name: string, args: Record<string, unknown>) =>
    modern(
      'tools/call',
      { name, arguments: args },
      requestId ? { 'x-request-id': `${requestId}/att1` } : {}
    );

  it('refuses write_stdin from a chat that does not own the session, and keeps serving the one that does', async () => {
    expect(prove('wfr_execown_opener', 'conv-execown-opener')).toBe('stored');
    expect(prove('wfr_execown_stranger', 'conv-execown-stranger')).toBe('stored');

    await fs.writeFile(
      path.join(mcpHarness.approved, 'owned-stdin.cjs'),
      "const readline=require('node:readline'); const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); rl.on('line',(line)=>{ console.log('echo='+line); if(line==='bye') rl.close(); });\n",
      'utf8'
    );

    const started = await asChat('wfr_execown_opener', 'exec_command', {
      cmd: 'node owned-stdin.cjs',
      workdir: '/workspace',
      tty: true,
      yield_time_ms: 25
    });
    expect(started.body.result?.isError).not.toBe(true);
    const sessionId = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(sessionId)).toBe(true);

    // Another chat can guess a small integer, so execution state must stay bound to its owner.
    const stranger = await asChat('wfr_execown_stranger', 'write_stdin', {
      session_id: sessionId,
      chars: 'stolen\r',
      yield_time_ms: 250
    });
    expect(stranger.body.result?.isError).toBe(true);
    expect(textOf(stranger)).toContain(`write_stdin failed for session ${sessionId}`);
    expect(textOf(stranger)).not.toContain('echo=stolen');
    expect(textOf(stranger)).toContain('This refusal concerns this process id, not Read-only mode');
    expect(textOf(stranger)).toContain('EXEC_SESSION_OWNER_MISMATCH');
    expect(textOf(stranger)).not.toContain('may already have delivered');

    // An unresolved request from another turn has no authority from the numeric id alone. If exact proof never arrives, the bounded wait must still fail closed without sending input or reading process output.
    const unproven = await asChat('wfr_execown_unattributed', 'write_stdin', {
      session_id: sessionId,
      chars: 'unproven\r',
      yield_time_ms: 1_000
    });
    expect(unproven.body.result?.isError).toBe(true);
    expect(textOf(unproven)).not.toContain('echo=unproven');
    expect(textOf(unproven)).toContain('EXEC_CALLER_UNIDENTIFIED');
    expect(textOf(unproven)).toContain('not Read-only mode');

    // A later request from the same durable session can race the page proof for its exact request id. The one call should recover when that proof arrives instead of making the model retry a session it already owns.
    const lateRequestId = 'wfr_execown_late_same_owner';
    let lateProofResult: string | undefined;
    const lateProof = new Promise<void>((resolve) => {
      setTimeout(() => {
        lateProofResult = prove(lateRequestId, 'conv-execown-opener');
        resolve();
      }, 250);
    });
    const recovered = await asChat(lateRequestId, 'write_stdin', {
      session_id: sessionId,
      chars: 'anon\r',
      yield_time_ms: 1_000
    });
    await lateProof;
    expect(lateProofResult).toBe('stored');
    expect(recovered.body.result?.isError).not.toBe(true);
    expect(textOf(recovered)).toContain('echo=anon');


    const owner = await asChat('wfr_execown_opener', 'write_stdin', {
      session_id: sessionId,
      chars: 'bye\r',
      yield_time_ms: 5_000
    });
    expect(owner.body.result?.isError).not.toBe(true);
    expect(textOf(owner)).toContain('echo=bye');
    expect(textOf(owner)).toContain('Process exited with code 0');
  });

  it('distinguishes unresolved, anonymous and unavailable process custody and reports identity recovery', async () => {
    const source = await createSession({ conversationId: 'exec-return-owner' });
    expect(prove('wfr_exec_return_owner', 'exec-return-owner', source.id)).toBe('stored');
    noteExecOwner(987001, source.id);
    noteExecOwner(987002, null);
    try {
      const unknown = await asChat('wfr_exec_return_late', 'write_stdin', { session_id: 987001, chars: '' });
      expect(unknown.body.result?.isError).toBe(true);
      expect(textOf(unknown)).toContain('EXEC_CALLER_UNIDENTIFIED');
      expect(prove('wfr_exec_return_late', 'exec-return-owner', source.id)).toBe('stored');
      const recovered = await asChat('wfr_exec_return_owner', 'read', { paths: ['/workspace/src/app.ts'] });
      expect(textOf(recovered)).toContain('Earlier write_stdin calls were refused');
      expect(textOf(await asChat('wfr_exec_return_owner', 'read', { paths: ['/workspace/src/app.ts'] })))
        .not.toContain('Identity recovered');
      const anonymous = await asChat('wfr_exec_return_owner', 'write_stdin', { session_id: 987002, chars: '' });
      expect(textOf(anonymous)).toContain('EXEC_SESSION_ANONYMOUS');
      expect(textOf(anonymous)).toContain('cannot adopt');
      expect(textOf(anonymous)).not.toContain('retry this same');
      const absent = await asChat('wfr_exec_return_owner', 'write_stdin', { session_id: 987003, chars: '' });
      expect(textOf(absent)).toContain('EXEC_SESSION_UNAVAILABLE');
      expect(textOf(absent)).not.toContain('retry this same');
      expect(textOf(await asChat('wfr_exec_return_owner', 'read', { paths: ['/workspace/src/app.ts'] })))
        .not.toContain('Identity recovered');
    } finally {
      forgetExecOwner(987001);
      forgetExecOwner(987002);
    }
  });

  it('keeps a live process with the durable session across Compact & Resume and retires A', async () => {
    const chatA = 'f0f00005-1111-4111-8111-111111111111';
    const chatB = 'f0f00006-1111-4111-8111-111111111111';
    const summary = await createSession({ title: 'exec continuation owner', conversationId: chatA });
    expect(prove('wfr_exec_resume_a', chatA, summary.id)).toBe('stored');

    await fs.writeFile(
      path.join(mcpHarness.approved, 'resume-stdin.cjs'),
      "const readline=require('node:readline'); const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); rl.on('line',(line)=>{ console.log('continued='+line); if(line==='done') rl.close(); });\n",
      'utf8'
    );
    const started = await asChat('wfr_exec_resume_a', 'exec_command', {
      cmd: 'node resume-stdin.cjs',
      workdir: '/workspace',
      tty: true,
      yield_time_ms: 25
    });
    const processId = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(processId), textOf(started)).toBe(true);
    expect(execOwner(processId)).toBe(summary.id);

    expect(await rebindSession(summary.id, chatA, chatB)).toBe(true);
    expect(prove('wfr_exec_resume_b', chatB, summary.id)).toBe('stored');

    const continued = await asChat('wfr_exec_resume_b', 'write_stdin', {
      session_id: processId,
      chars: 'done\r',
      yield_time_ms: 5_000
    });
    expect(failed(continued), textOf(continued)).toBe(false);
    expect(textOf(continued)).toContain('continued=done');

    const stale = await asChat('wfr_exec_resume_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(stale)).toBe(true);
    expect(textOf(stale)).toContain('CONVERSATION_SUPERSEDED');
    expect(textOf(stale)).toContain('no local tool was run');
  });

  it('refuses every tool from a chat whose handoff brief has been asked for, until the move is over', async () => {
    resetContinuationsForTests();
    const chatA = 'f0f00007-1111-4111-8111-111111111111';
    const chatB = 'f0f00008-1111-4111-8111-111111111111';
    const summary = await createSession({ title: 'compacting owner', conversationId: chatA });
    expect(prove('wfr_compact_a', chatA, summary.id)).toBe('stored');

    // A filed ticket alone changes nothing: the page may still be stopping the turn.
    const opened = await openContinuationNow(summary.id, chatA, true);
    const beforePrompt = await asChat('wfr_compact_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(beforePrompt), textOf(beforePrompt)).toBe(false);

    // The marked prompt is submitted. From here on the chat's calls are refused — whether the turn Stop was clicked on really ended or, as on 2026-09-01, went on calling tools.
    expect((await beginContinuationSourceSendNow(opened.token))?.allowed).toBe(true);
    expect(await dispatchContinuationSourceSendNow(opened.token)).toBe(true);
    const duringHandoff = await asChat('wfr_compact_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(duringHandoff)).toBe(true);
    expect(textOf(duringHandoff)).toContain('COMPACTION_IN_PROGRESS');
    expect(textOf(duringHandoff)).toMatch(/no local tool was run/i);
    expect(textOf(duringHandoff)).toMatch(/write that brief now/i);

    // Still refused once the brief is stored and the replacement chat is on its way.
    await attachSummary(opened.token, 'SUMMARY\n'.repeat(40));
    const afterBrief = await asChat('wfr_compact_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(afterBrief)).toContain('COMPACTION_IN_PROGRESS');

    // The commit hands the refusal over to the superseded attachment for good.
    expect(await rebindSession(summary.id, chatA, chatB)).toBe(true);
    expect(prove('wfr_compact_b', chatB, summary.id)).toBe('stored');
    abortContinuation(opened.token, 'the test moved the session by hand');
    const stale = await asChat('wfr_compact_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(stale)).toBe(true);
    expect(textOf(stale)).toContain('CONVERSATION_SUPERSEDED');
    const fresh = await asChat('wfr_compact_b', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(fresh), textOf(fresh)).toBe(false);
  });

  it('does not let a stale owner inherit a recycled process id during the new exec yield', async () => {
    // Model the real lifetime split directly: the manager has released an exited process id, but the separate ownership registry still carries the chat that used to own it. Force the next allocator pick to reuse that number so the race is deterministic instead of a 1-in-99k lottery.
    await unifiedExecManager.terminateAllProcesses();
    const recycledId = 1_000;
    noteExecOwner(recycledId, 'session-conv-execown-old');
    expect(execOwner(recycledId)).toBe('session-conv-execown-old');
    expect(prove('wfr_execown_old_recycled', 'conv-execown-old')).toBe('stored');
    expect(prove('wfr_execown_new_recycled', 'conv-execown-new')).toBe('stored');

    const allocate = unifiedExecManager.allocateProcessId.bind(unifiedExecManager);
    const allocation = vi.spyOn(unifiedExecManager, 'allocateProcessId').mockImplementation(() => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0);
      try { return allocate(); } finally { random.mockRestore(); }
    });
    // Hold only publication of the real process result, not process creation or ownership. The process is alive and writable, but the MCP handler has not yet installed its new owner. This is the same custody gap without racing a five-second shell-startup budget against the one-second exec yield on a loaded Windows runner.
    const execute = unifiedExecManager.execCommand.bind(unifiedExecManager);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let reached!: (output: Awaited<ReturnType<typeof execute>>) => void;
    const atPublication = new Promise<Awaited<ReturnType<typeof execute>>>(resolve => { reached = resolve; });
    const execution = vi.spyOn(unifiedExecManager, 'execCommand').mockImplementation(async request => {
      const output = await execute(request);
      reached(output);
      await held;
      return output;
    });
    let starting: ReturnType<typeof asChat> | undefined;
    try {
      // Block in the shell process itself. Spawning a second cold `node` here made this ownership regression depend on hosted-runner process startup rather than on the authority window it is meant to test. The shell is already the exec process and can wait for one line of input without another child at all.
      const holdOpen = IS_WINDOWS
        ? "$line = [Console]::In.ReadLine(); Write-Output ('got=' + $line)"
        : "IFS= read -r line; printf 'got=%s\\n' \"$line\"";

      // Do not await. The process is registered while exec_command spends its initial yield collecting output, which is the exact old authority window.
      starting = asChat('wfr_execown_new_recycled', 'exec_command', {
        cmd: holdOpen,
        workdir: '/workspace',
        tty: true,
        yield_time_ms: 1_000
      });
      // Surface a pre-launch refusal instead of hanging on a signal that can never arrive.
      const boundary = await Promise.race([
        atPublication.then(output => ({ output })),
        starting.then(reply => ({ reply }))
      ]);
      if ('reply' in boundary) throw new Error(`Exec did not reach publication: ${textOf(boundary.reply)}`);
      expect(boundary.output.processId).toBe(recycledId);
      expect(unifiedExecManager.listProcesses().some(entry => entry.processId === recycledId)).toBe(true);

      // Allocation must have removed the stale principal before the new process became writable. The old chat knows this integer from its own previous session, but it no longer has authority over what now happens to occupy that slot.
      expect(execOwner(recycledId)).toBeNull();
      const stolen = await asChat('wfr_execown_old_recycled', 'write_stdin', {
        session_id: recycledId,
        chars: 'stolen\r',
        yield_time_ms: 50
      });
      expect(stolen.body.result?.isError).toBe(true);
      expect(textOf(stolen)).toContain('EXEC_SESSION_UNAVAILABLE');

      release();
      const started = await starting;
      expect(started.body.result?.isError, textOf(started)).not.toBe(true);
      expect(Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1])).toBe(recycledId);
      expect(execOwner(recycledId)).toBe('session-conv-execown-new');
      expect(textOf(started)).not.toContain('got=');

      // Let the real owner release the shell normally. Besides proving the new principal did receive authority, this keeps cleanup deterministic instead of spending the process manager's kill grace period on an intentionally blocked test process.
      const owner = await asChat('wfr_execown_new_recycled', 'write_stdin', {
        session_id: recycledId,
        chars: 'owner\r',
        yield_time_ms: 5_000
      });
      expect(owner.body.result?.isError, textOf(owner)).not.toBe(true);
      expect(textOf(owner)).toContain('got=owner');
      expect(textOf(owner)).toContain('Process exited with code 0');
    } finally {
      release();
      await starting?.catch(() => undefined);
      execution.mockRestore();
      allocation.mockRestore();
      await unifiedExecManager.terminateAllProcesses();
      resetExecOwnershipForTests();
    }
  });

  it('delivers completed output on an ordinary same-request call without leaking it', async () => {
    expect(prove('wfr_background_owner', 'conv-background-owner')).toBe('stored');
    expect(prove('wfr_background_other', 'conv-background-other')).toBe('stored');
    const started = await asChat('wfr_background_owner', 'exec_command', {
      cmd: IS_WINDOWS
        ? "Start-Sleep -Milliseconds 650; Write-Output 'background-e2e-once'; exit 7"
        : "sleep 0.65; printf '%s\\n' background-e2e-once; exit 7",
      workdir: '/workspace',
      yield_time_ms: 250
    });
    expect(failed(started), textOf(started)).toBe(false);
    const sessionId = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(sessionId)).toBe(true);

    const owned = new Set([sessionId]);
    await vi.waitFor(() => expect(unifiedExecManager.exitedUnread(owned)).toHaveLength(1), {
      timeout: 5_000,
      interval: 20
    });
    const exitCode = unifiedExecManager.exitedUnread(owned)[0]!.exitCode;
    expect(exitCode).toBe(7);
    expect(unifiedExecManager.exitedUnread(new Set())).toEqual([]);

    const stranger = await asChat('wfr_background_other', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(stranger)).not.toContain(`Background session ${sessionId}`);

    const later = await asChat('wfr_background_owner', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(later)).toContain(`Background session ${sessionId} completed`);
    expect(textOf(later)).toContain(`Exit code: ${exitCode}`);
    expect(textOf(later)).toContain('background-e2e-once');
    expect(textOf(later)).not.toContain(`write_stdin(session_id=${sessionId}`);

    // Publication receipts require a strictly later timestamp; loopback calls can otherwise share one millisecond even though this response was already read.
    const receivedAt = Date.now();
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(receivedAt), { timeout: 1000, interval: 1 });
    const after = await asChat('wfr_background_owner', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(after)).not.toContain(`Background session ${sessionId}`);
    expect(unifiedExecManager.exitedUnread(owned)).toEqual([]);
    const reread = await asChat('wfr_background_owner', 'write_stdin', { session_id: sessionId, chars: '' });
    expect(failed(reread), textOf(reread)).toBe(false);
    expect(textOf(reread)).toContain('Retained output');
    expect(textOf(reread)).toContain('background-e2e-once');
    expect(textOf(reread)).toContain('Process exited with code 7');
    const forbidden = await asChat('wfr_background_other', 'write_stdin', { session_id: sessionId, chars: '' });
    expect(failed(forbidden)).toBe(true);
    expect(textOf(forbidden)).not.toContain('background-e2e-once');
    const direct = await asChat('wfr_background_owner', 'exec_command', {
      cmd: IS_WINDOWS ? "Write-Output 'direct-result'; exit 0" : "printf '%s\\n' direct-result",
      workdir: '/workspace', yield_time_ms: 10000
    });
    expect(failed(direct), textOf(direct)).toBe(false);
    const completedId = Number(textOf(direct).match(/Completed session ID: (\d+)/)?.[1]);
    expect(Number.isInteger(completedId)).toBe(true);
    const directRead = await asChat('wfr_background_owner', 'write_stdin', { session_id: completedId, chars: '' });
    expect(failed(directRead), textOf(directRead)).toBe(false);
    expect(textOf(directRead)).toContain('direct-result');
  });

  it('reoffers completed output after the real HTTP connection closes before publication', async () => {
    const requestId = 'wfr_background_disconnect';
    expect(prove(requestId, 'conv-background-disconnect')).toBe('stored');
    const started = await asChat(requestId, 'exec_command', {
      cmd: IS_WINDOWS ? "Start-Sleep -Milliseconds 650; Write-Output 'transport-replay'" : "sleep 0.65; echo transport-replay",
      workdir: '/workspace', yield_time_ms: 250
    });
    expect(failed(started), textOf(started)).toBe(false);
    const id = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(id), textOf(started)).toBe(true);
    // Match the adjacent real-process test's deadline: PowerShell startup competes with native compilation in the full suite and is not bounded by this command's 650 ms sleep.
    await vi.waitFor(() => expect(unifiedExecManager.exitedUnread(new Set([id]))).toHaveLength(1), {
      timeout: 5_000, interval: 20
    });
    const offer = unifiedExecManager.offerCompletedOutput.bind(unifiedExecManager);
    let publication: Parameters<typeof offer>[1] | undefined;
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const spy = vi.spyOn(unifiedExecManager, 'offerCompletedOutput').mockImplementation(async (...args) => {
      const result = await offer(...args);
      publication = args[1];
      await gate;
      return result;
    });
    const controller = new AbortController();
    const aborted = fetch(mcpHarness.endpoint.urls.core, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-request-id': requestId },
      body: JSON.stringify({ jsonrpc: '2.0', id: mcpHarness.nextId++, method: 'tools/call', params: { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } } })
    }).catch(() => null);
    try {
      await vi.waitFor(() => expect(publication).toBeDefined());
      controller.abort();
      await aborted;
      await vi.waitFor(() => expect(publication?.failed).toBe(true));
    } finally { unblock(); spy.mockRestore(); }
    const replay = await asChat(requestId, 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(replay)).toContain('transport-replay');
    expect(unifiedExecManager.exitedUnread(new Set([id]))).toHaveLength(1);
    // Receipts require a strictly later invocation timestamp. Fast CI can receive both HTTP responses in one millisecond, which is intentionally not a receipt boundary.
    const replayReceivedAt = Date.now();
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(replayReceivedAt));
    const receipt = await asChat(requestId, 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(receipt)).not.toContain('transport-replay');
    expect(unifiedExecManager.exitedUnread(new Set([id]))).toEqual([]);
  });

  it('refuses new commands at the unread-result bound, delivers a result, then admits after automatic receipt', async () => {
    const conversationId = 'conv-background-admission';
    const sessionIds: number[] = [];

    for (let index = 0; index < MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION; index++) {
      const requestId = `wfr_background_admission_${index}`;
      expect(prove(requestId, conversationId)).toBe('stored');
      const started = await asChat(requestId, 'exec_command', {
        cmd: IS_WINDOWS
          ? `while (!(Test-Path './delivery-release')) { Start-Sleep -Milliseconds 30 }; Write-Output 'owed-${index}'; exit ${index + 1}`
          : `while [ ! -f ./delivery-release ]; do sleep 0.03; done; printf '%s\\n' owed-${index}; exit ${index + 1}`,
        workdir: '/workspace',
        yield_time_ms: 100
      });
      const sessionId = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
      expect(Number.isInteger(sessionId), textOf(started)).toBe(true);
      sessionIds.push(sessionId);
    }

    await fs.writeFile(path.join(mcpHarness.approved, 'delivery-release'), 'ready');
    await vi.waitFor(
      () => expect(backgroundExecObligations(`session-${conversationId}`).exitedUnread.map((row) => row.processId)).toEqual(
        [...sessionIds].sort((left, right) => left - right)
      ),
      { timeout: 8_000, interval: 25 }
    );

    const blockedRequest = 'wfr_background_admission_blocked';
    expect(prove(blockedRequest, conversationId)).toBe('stored');
    const offer = unifiedExecManager.offerCompletedOutput.bind(unifiedExecManager);
    let publication: Parameters<typeof offer>[1] | undefined;
    const published = vi.spyOn(unifiedExecManager, 'offerCompletedOutput').mockImplementation(async (...args) => {
      publication = args[1];
      return offer(...args);
    });
    let blocked: Awaited<ReturnType<typeof asChat>>;
    try {
      blocked = await asChat(blockedRequest, 'exec_command', {
        cmd: IS_WINDOWS ? "Write-Output 'must-not-run'" : "printf '%s\\n' must-not-run",
        workdir: '/workspace'
      });
      // A later invocation acknowledges only a successfully published page whose completion timestamp is strictly earlier. Observe that boundary instead of retrying commands.
      await vi.waitFor(() => {
        expect(publication?.failed).toBe(false);
        expect(publication?.completedAt).toBeTypeOf('number');
        expect(Date.now()).toBeGreaterThan(publication!.completedAt!);
      });
    } finally {
      published.mockRestore();
    }
    expect(failed(blocked)).toBe(true);
    expect(textOf(blocked)).toContain('EXEC_RESULTS_UNREAD');
    for (const sessionId of sessionIds) expect(textOf(blocked)).toContain(String(sessionId));

    expect(textOf(blocked)).toMatch(/Background session \d+ completed/);
    expect(textOf(blocked)).toContain('owed-');

    const admitted = await asChat(blockedRequest, 'exec_command', {
      cmd: IS_WINDOWS ? "Write-Output 'admitted-after-drain'" : "printf '%s\\n' admitted-after-drain",
      workdir: '/workspace',
      yield_time_ms: 5_000
    });
    expect(failed(admitted), textOf(admitted)).toBe(false);
    expect(textOf(admitted)).toContain('admitted-after-drain');

    for (const sessionId of sessionIds.slice(1)) {
      await asChat(blockedRequest, 'write_stdin', { session_id: sessionId, chars: '' });
    }
    await fs.unlink(path.join(mcpHarness.approved, 'delivery-release'));
  });

  it('pings a live session left unpolled once, without blocking work or reaching another chat', async () => {
    expect(prove('wfr_background_unattended', 'conv-background-unattended')).toBe('stored');
    expect(prove('wfr_background_stranger', 'conv-background-stranger')).toBe('stored');
    const started = await asChat('wfr_background_unattended', 'exec_command', {
      cmd: IS_WINDOWS ? 'Start-Sleep -Seconds 30' : 'sleep 30',
      workdir: '/workspace',
      yield_time_ms: 250
    });
    const sessionId = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(sessionId), textOf(started)).toBe(true);

    try {
      // Inside the threshold a live session is just work in progress, and says nothing.
      const quiet = await asChat('wfr_background_unattended', 'read', { paths: ['/workspace/src/app.ts'] });
      expect(textOf(quiet)).not.toContain(`Background session ${sessionId}`);

      backdateExecAttendanceForTests(sessionId, UNATTENDED_EXEC_NOTICE_MS + 60_000);

      const stranger = await asChat('wfr_background_stranger', 'read', { paths: ['/workspace/src/app.ts'] });
      expect(textOf(stranger)).not.toContain(`Background session ${sessionId}`);

      const pinged = await asChat('wfr_background_unattended', 'read', { paths: ['/workspace/src/app.ts'] });
      expect(textOf(pinged)).toContain(`Background session ${sessionId} has been running unpolled for 3m`);
      expect(textOf(pinged)).toContain(`write_stdin(session_id=${sessionId}, chars="")`);

      // A published reminder is suppressed until attendance starts a new idle span.
      expect(prove('wfr_background_unattended_next', 'conv-background-unattended')).toBe('stored');
      const again = await asChat('wfr_background_unattended_next', 'read', { paths: ['/workspace/src/app.ts'] });
      expect(textOf(again)).not.toContain(`Background session ${sessionId}`);

      // A reminder is not admission pressure. The session it names may be the point of the turn, so unlike a completed unread result it never spends the exec_command budget.
      const admitted = await asChat('wfr_background_unattended', 'exec_command', {
        cmd: IS_WINDOWS ? "Write-Output 'still-admitted'" : "printf '%s\n' still-admitted",
        workdir: '/workspace',
        yield_time_ms: 5_000
      });
      expect(failed(admitted), textOf(admitted)).toBe(false);
      expect(textOf(admitted)).toContain('still-admitted');
    } finally {
      await unifiedExecManager.terminateProcess(sessionId);
    }
  });

  it('restarts the unattended clock when the owner polls, rather than reminding it of what it just did', async () => {
    expect(prove('wfr_background_attended', 'conv-background-attended')).toBe('stored');
    const started = await asChat('wfr_background_attended', 'exec_command', {
      cmd: IS_WINDOWS
        ? "while ($true) { Write-Output 'tick'; Start-Sleep -Milliseconds 200 }"
        : "while true; do printf '%s\n' tick; sleep 0.2; done",
      workdir: '/workspace',
      yield_time_ms: 250
    });
    const sessionId = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(sessionId), textOf(started)).toBe(true);

    try {
      backdateExecAttendanceForTests(sessionId, UNATTENDED_EXEC_NOTICE_MS + 60_000);
      const polled = await asChat('wfr_background_attended', 'write_stdin', {
        session_id: sessionId,
        chars: ''
      });
      expect(failed(polled), textOf(polled)).toBe(false);
      expect(textOf(polled)).toContain('tick');
      // The mark lands before the wait, so the poll cannot report the session it is attending.
      expect(textOf(polled)).not.toContain('has been running unpolled');

      const after = await asChat('wfr_background_attended', 'read', { paths: ['/workspace/src/app.ts'] });
      expect(textOf(after)).not.toContain(`Background session ${sessionId}`);
    } finally {
      await unifiedExecManager.terminateProcess(sessionId);
    }
  });
});
