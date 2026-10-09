import {
  DEFAULT_CAPABILITIES,
  PRIME_CHAT,
  PRIME_ID,
  REFUSED_ON_ROOTS,
  bindConversation,
  clearAgent,
  currentRunId,
  dir,
  finishAgent,
  flushDurable,
  fs,
  identify,
  offerMessagesForConversation,
  onSpawnRequest,
  onSwarmPersist,
  onSwarmPersistNow,
  path,
  pendingWorkerRevivals,
  pendingWorkerSpawns,
  prime,
  readDurable,
  recordChatObservations,
  releaseQuiescentRun,
  setEnabled,
  snapshotSwarm,
  spawn,
  startMcpServer,
  startSwarm,
  startWorker,
  swarmRunning,
  workspaceForChat,
  writeDurableSoon,
} from './context.js';
import {
  agents,
  agentsWithRequestId,
  asChat,
  callTool,
  mcpState,
  ordinaryWithRequestId,
  post,
  replyWithRequestId,
  startMcpEndpoint,
  stopMcpEndpoint,
  structuredAsChat,
  textOfReply,
} from './mcp-context.js';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

describe('through the MCP endpoint', () => {
  beforeEach(startMcpEndpoint);
  afterEach(stopMcpEndpoint);

  // One flat tool with five actions. The names it replaced are gone outright, not aliased, so a chat still holding the old instructions gets an honest unknown-tool error.
    it('publishes one agents tool with exactly four actions', async () => {
      const reply = await post({ jsonrpc: '2.0', id: mcpState.nextId++, method: 'tools/list', params: {} });
      const names = (reply.result.tools as Array<{ name: string }>).map((tool) => tool.name);
      expect(names).toContain('agents');
      for (const gone of [
        'agent_inbox',
        'agent_status',
        'create_agents',
        'finish_agent',
        'join_agent',
        'revive_agent',
        'send_agent_message'
      ]) {
        expect(names).not.toContain(gone);
      }

      const schema = (reply.result.tools as Array<{ name: string; inputSchema: any }>).find(
        (tool) => tool.name === 'agents'
      )!.inputSchema;
      expect(schema.properties.action.enum.slice().sort()).toEqual(['finish', 'message', 'spawn', 'status']);
      expect(schema.properties.target_run_id).toBeDefined();
      // Revive is gone from the wire as well as from the broker: no field survives for it.
      expect(Object.keys(schema.properties)).not.toContain('agent');
    });

  it('is identified by exact request-id evidence that arrived before the call it names', async () => {
      // Evidence may arrive before HTTP. The timestamp is irrelevant; the normalized request id is the join, so a pre-existing exact mate remains authoritative.
      await recordChatObservations('c-ahead', [
        { kind: 'turn_start', time: Date.now() - 5_500, turnId: 't-ahead' },
        {
          kind: 'tool_evidence',
          time: Date.now() - 5_500,
          turnId: 't-ahead',
          calls: [{ messageId: 'm-ahead', tool: 'agents', order: 0, answered: false, requestId: 'wfr_agents_ahead' }]
        }
      ]);

      const text = await agentsWithRequestId('wfr_agents_ahead', 'spawn', { workers: [{ task: 'read the file' }] });

      expect(text).not.toContain('UNIDENTIFIED_CALLER');
      expect(swarmRunning()).toBe(true);
      expect(identify({ conversationId: 'c-ahead' }).id).toBe(PRIME_ID);
    });

  it('refuses a spawn whose conversation this app cannot prove, and creates nothing', async () => {
      const text = await agents('spawn', { workers: [{ task: 'anything' }] });
      expect(text).toMatch(/UNIDENTIFIED_CALLER|could not/i);
      expect(swarmRunning()).toBe(false);
      expect(pendingWorkerSpawns()).toEqual([]);
    });

  it('keeps ordinary request-scoped patch and command access while a swarm is active', async () => {
      const workspace = path.join(dir, 'unattributed-ordinary-tools');
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(path.join(workspace, 'state.txt'), 'before\n', 'utf8');
      mcpState.toolContext = {
        roots: [{ name: 'workspace', path: workspace }],
        caps: { ...DEFAULT_CAPABILITIES, create: true, edit: true, command: true },
        readOnly: false,
        sessionTools: true,
        agentTools: true
      };
      await setEnabled(true, 3, true);
      startSwarm(1);
      const requestId = 'wfr_unattributed_ordinary_tools';
      try {
        const absolutePatch = [
          '*** Begin Patch',
          '*** Update File: /workspace/state.txt',
          '@@',
          '-before',
          '+after absolute',
          '*** End Patch'
        ].join('\n');
        const absolute = await ordinaryWithRequestId(requestId, 'apply_patch', { patch: absolutePatch });
        expect(absolute.result?.isError, textOfReply(absolute)).not.toBe(true);

        // The absolute patch taught this unresolved request its project. A later relative patch in the same model turn must retain that workspace even though no chat id exists yet.
        const relativePatch = [
          '*** Begin Patch',
          '*** Update File: state.txt',
          '@@',
          '-after absolute',
          '+after relative',
          '*** End Patch'
        ].join('\n');
        const relative = await ordinaryWithRequestId(requestId, 'apply_patch', { patch: relativePatch });
        expect(relative.result?.isError, textOfReply(relative)).not.toBe(true);
        expect(await fs.readFile(path.join(workspace, 'state.txt'), 'utf8')).toBe('after relative\n');

        const command = await ordinaryWithRequestId(requestId, 'exec_command', {
          cmd: `node -e "process.stdout.write(require('node:fs').readFileSync('state.txt','utf8'))"`,
          workdir: '/workspace',
          yield_time_ms: 5_000
        });
        expect(command.result?.isError, textOfReply(command)).not.toBe(true);
        expect(textOfReply(command)).toContain('after relative');

        const agent = await ordinaryWithRequestId(requestId, 'agents', {
          action: 'spawn', workers: [{ task: 'Review this request workspace before chat proof' }]
        });
        expect(agent.result?.isError, textOfReply(agent)).not.toBe(true);
        const runId = agent.result.structuredContent.run_id;
        expect(typeof runId).toBe('string');
        expect(textOfReply(agent)).toContain('This request is now the prime');
        expect(bindConversation('worker-1', 'request-owned-wire-worker', runId)).toBe(true);
        expect(workspaceForChat('request-owned-wire-worker')?.real).toBe(workspace);
        finishAgent({ conversationId: 'request-owned-wire-worker' }, 'Request-owned report delivered');
        const outsider = await ordinaryWithRequestId('wfr_ordinary_outsider', 'read', { paths: ['/workspace/state.txt'] });
        expect(textOfReply(outsider)).not.toContain('Request-owned report delivered');
        const inbox = await ordinaryWithRequestId(requestId, 'read', { paths: ['/workspace/state.txt'] });
        expect(inbox.result?.isError, textOfReply(inbox)).not.toBe(true);
        expect(textOfReply(inbox)).toContain('Request-owned report delivered');
        // Recovery notices depend on an eligible browser incident, not on whether this exact request can read its workspace and receive its worker report.
        expect(textOfReply(inbox)).not.toContain('Agent/subagent operations and chat lifecycle finish signals still need exact identity');
        const ack = await ordinaryWithRequestId(requestId, 'read', { paths: ['/workspace/state.txt'] });
        expect(textOfReply(ack)).not.toContain('Request-owned report delivered');
      } finally {
        await setEnabled(true, 3, false);
      }
    });

  it('reattaches a request fleet over MCP, selects its workers and returns the new incarnation when waking it', async () => {
      await setEnabled(true, 3, true);
      const conversationId = 'mcp-recovered-fleets';
      const prove = (requestId: string) => recordChatObservations(conversationId, [
        { kind: 'turn_start', time: Date.now(), turnId: requestId },
        { kind: 'tool_evidence', time: Date.now(), turnId: requestId,
          calls: [{ messageId: `m-${requestId}`, tool: 'agents', order: 0, answered: false, requestId }] }
      ]);
      try {
        await prove('wfr_mcp_original_fleet');
        const original = await replyWithRequestId('wfr_mcp_original_fleet', 'spawn', { workers: [{ task: 'Existing work' }] });
        const recovered = await replyWithRequestId('wfr_mcp_recovered_fleet', 'spawn', { workers: [{ task: 'Recovered work' }] });
        expect(recovered.result?.isError, textOfReply(recovered)).not.toBe(true);
        const firstRun = original.result.structuredContent.run_id;
        const recoveredRun = recovered.result.structuredContent.run_id;
        expect(bindConversation('worker-1', 'mcp-original-worker', firstRun)).toBe(true);
        expect(bindConversation('worker-1', 'mcp-recovered-worker', recoveredRun)).toBe(true);
        await prove('wfr_mcp_recovered_fleet');
        const status = await replyWithRequestId('wfr_mcp_recovered_fleet', 'status', {});
        expect(status.result.structuredContent.available_runs).toHaveLength(2);
        const ambiguous = await replyWithRequestId('wfr_mcp_recovered_fleet', 'message', { to: 'worker-1', text: 'Ambiguous' });
        expect(ambiguous.result.isError).toBe(true);
        expect(textOfReply(ambiguous)).toContain('RUN_SELECTION_REQUIRED');
        const message = await replyWithRequestId('wfr_mcp_recovered_fleet', 'message', { run_id: recoveredRun, to: 'worker-1', text: 'Only recovered worker' });
        expect(message.result?.isError, textOfReply(message)).not.toBe(true);
        expect(offerMessagesForConversation('mcp-original-worker')?.messages).toEqual([]);
        expect(offerMessagesForConversation('mcp-recovered-worker')?.messages[0]?.text).toBe('Only recovered worker');
        await asChat('mcp-recovered-worker', 'finish', { result: 'Done with first task' });
        const wake = await replyWithRequestId('wfr_mcp_recovered_fleet', 'message', { run_id: recoveredRun, to: 'worker-1', text: 'Follow-up task' });
        expect(wake.result?.isError, textOfReply(wake)).not.toBe(true);
        const newRun = wake.result.structuredContent.run_id;
        expect(newRun).not.toBe(recoveredRun);
        expect(pendingWorkerRevivals().some(worker => worker.runId === newRun && worker.conversationId === 'mcp-recovered-worker')).toBe(true);
        expect((await replyWithRequestId('wfr_mcp_recovered_fleet', 'status', { run_id: newRun })).result.structuredContent.run_id).toBe(newRun);
      } finally { await setEnabled(true, 3, false); }
    });

  it('publishes each accepted MCP spawn to its own run when another prime is active', async () => {
      const opened = vi.fn();
      const dispose = onSpawnRequest(opened);
      try {
        await asChat('prime-existing', 'spawn', { workers: [{ task: 'existing work' }] });
        await asChat('prime-new', 'spawn', { workers: [{ task: 'new work' }] });
        expect(opened).toHaveBeenCalledTimes(2);
        expect(opened.mock.calls.map(([workers]) => workers)).toEqual([
          [expect.objectContaining({ id: 'worker-1', runId: currentRunId('prime-existing'), primeConversationId: 'prime-existing', task: 'existing work' })],
          [expect.objectContaining({ id: 'worker-1', runId: currentRunId('prime-new'), primeConversationId: 'prime-new', task: 'new work' })]
        ]);
      } finally {
        dispose();
      }
    });

  it('rolls back a spawn whose durable acceptance barrier fails instead of resurrecting it from the debounce', async () => {
      const stateName = 'spawn-atomicity-failure';
      onSwarmPersist(() => writeDurableSoon(stateName, snapshotSwarm()));
      onSwarmPersistNow(async () => {
        throw new Error('injected spawn durability failure');
      });

      const failed = await asChat(PRIME_CHAT, 'spawn', { workers: [{ task: 'audit the parser' }] });
      expect(failed).toMatch(/durable acceptance barrier|durab|injected spawn durability failure/i);

      // A failed public operation must not keep an invisible run claim in memory. More importantly, spawn() already fired the ordinary debounced persistence callback before the immediate barrier ran; if that callback was allowed to see the staged topology, a later restart would restore it and replay pendingWorkerSpawns(), opening a worker tab for a spawn ChatGPT was explicitly told had failed.
      expect(swarmRunning()).toBe(false);
      expect(pendingWorkerSpawns()).toEqual([]);
      await flushDurable();
      expect(await readDurable(stateName)).toBeNull();
    });

  it('exposes no key field anywhere in the agents schema', async () => {
      const reply = await post({ jsonrpc: '2.0', id: mcpState.nextId++, method: 'tools/list', params: {} });
      const tools = reply.result.tools as Array<{ name: string; inputSchema: any }>;
      // Not on agents, and — the part that used to be false — not on any other tool either.
      for (const tool of tools) {
        expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('agent_key');
      }
      const agentsSchema = tools.find((tool) => tool.name === 'agents')!.inputSchema;
      // Not a key by any spelling: the recovery action that needed one is gone entirely.
      for (const field of Object.keys(agentsSchema.properties)) {
        expect(field).not.toMatch(/key|secret|token/i);
      }
      expect(JSON.stringify(agentsSchema)).not.toMatch(/join/i);
    });

  it('returns empty status to an unrelated chat without exposing the other run', async () => {
      startSwarm(1);
      const text = await asChat('c-stranger', 'status');
      expect(text).toContain('No workers or retained worker history');
      const status = await structuredAsChat('c-stranger', 'status');
      expect(status).toMatchObject({ self: null, run_id: null, agents: [] });
      expect(text).not.toContain('worker-1');
      expect(text).not.toContain('task 1');
      expect(text).not.toContain(PRIME_CHAT);
    });

  it('shows a parked prime only its own history while another prime owns the active run', async () => {
      spawn({ workers: [{ label: 'A history worker', task: 'A private task' }], caller: prime });
      expect(bindConversation('worker-1', 'c-worker-a')).toBe(true);
      finishAgent({ conversationId: 'c-worker-a' }, 'A done for now');
      expect(releaseQuiescentRun()).toBe(true);

      spawn({
        workers: [{ label: 'B live worker', task: 'B private task' }],
        caller: { conversationId: 'c-prime-b' }
      });
      const structured = await structuredAsChat(PRIME_CHAT, 'status');
      expect(structured.self).toBe(PRIME_ID);
      expect(structured.run_id).toBeNull();
      // A owns history but cannot consume the one global execution claim while B is active.
      expect(structured.free_worker_slots).toBe(3);
      expect(structured.agents).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'worker-1', label: 'A history worker', state: 'sleeping' })])
      );
      expect(JSON.stringify(structured)).not.toContain('B live worker');
      expect(JSON.stringify(structured)).not.toContain('B private task');
    });

  it('recognizes an exact sleeping worker still calling while another prime also executes', async () => {
      await setEnabled(true, 3, true);
      startSwarm(1);
      const worker = startWorker('worker-1');
      finishAgent(worker.caller, 'first prime work done');
      expect(releaseQuiescentRun()).toBe(true);
      expect(swarmRunning()).toBe(false);

      // Another prime is now entitled to the one active execution claim and may reuse the same friendly worker ids. The old exact worker conversation remains worker-owned history, not an ordinary chat that can keep using local tools.
      spawn({ workers: [{ task: 'second prime work' }], caller: { conversationId: 'c-prime-b' } });

      const requestId = 'wfr_dormant_worker_exact';
      await recordChatObservations('c-worker-1', [
        { kind: 'turn_start', time: Date.now(), turnId: 't-dormant-exact' },
        {
          kind: 'tool_evidence',
          time: Date.now(),
          turnId: 't-dormant-exact',
          calls: [{ messageId: 'm-dormant-exact', tool: 'read', order: 0, answered: false, requestId }]
        }
      ]);
      const reply = await ordinaryWithRequestId(requestId, 'read', { paths: ['/anything'] });
      const text = textOfReply(reply);
      await setEnabled(true);
      expect(text).not.toContain('WORKER_SLEEPING');
      expect(text).toMatch(REFUSED_ON_ROOTS);
      expect(identify({ conversationId: 'c-prime-b' }).id).toBe(PRIME_ID);
    });

  it('allows only ambiguous unattributed execution while preserving an exact retired-worker fence', async () => {
      startSwarm(1);
      startWorker('worker-1', 'c-retired-worker-policy');
      expect(clearAgent(PRIME_ID).cleared).toBe('run');

      const blocked = await callTool('read', { paths: ['/anything'] });
      expect(blocked).toContain('CALLER_IDENTITY_REQUIRED');

      await setEnabled(true, 3, true);
      const anonymous = await callTool('read', { paths: ['/anything'] });
      expect(anonymous).not.toContain('CALLER_IDENTITY_REQUIRED');
      expect(anonymous).toMatch(REFUSED_ON_ROOTS);

      const requestId = 'wfr_retired_worker_allow_unattributed';
      await recordChatObservations('c-retired-worker-policy', [
        { kind: 'turn_start', time: Date.now(), turnId: 't-retired-policy' },
        {
          kind: 'tool_evidence',
          time: Date.now(),
          turnId: 't-retired-policy',
          calls: [{ messageId: 'm-retired-policy', tool: 'read', order: 0, answered: false, requestId }]
        }
      ]);
      const exact = textOfReply(await ordinaryWithRequestId(requestId, 'read', { paths: ['/anything'] }));
      await setEnabled(true);
      expect(exact).toContain('WORKER_RETIRED');
    });

  it('explains scheduled-run permission with dormant history and never adopts that history', async () => {
      startSwarm(1);
      const worker = startWorker('worker-1');
      finishAgent(worker.caller, 'parked history');
      expect(releaseQuiescentRun()).toBe(true);

      const blocked = await callTool('read', { paths: ['/anything'] });
      expect(blocked).toContain('CALLER_IDENTITY_REQUIRED');
      expect(blocked).toContain('Scheduled or headless runs');
      expect(blocked).toContain('"Allow unattributed calls"');
      expect(swarmRunning()).toBe(false);

      await setEnabled(true, 3, true);
      const allowed = await callTool('read', { paths: ['/anything'] });
      expect(allowed).not.toContain('CALLER_IDENTITY_REQUIRED');
      // The ordinary sandbox now decides the call; no approved root was granted by this setting.
      expect(allowed).toMatch(REFUSED_ON_ROOTS);
      expect(swarmRunning()).toBe(false);

      await setEnabled(true);
      expect(await callTool('read', { paths: ['/anything'] })).toContain('CALLER_IDENTITY_REQUIRED');
    });

  it('permits an unattributed workspace-dependent call to fail honestly instead of guessing a chat', async () => {
      await setEnabled(true, 3, true);
      startSwarm(1);
      const text = await callTool('read', { paths: ['relative.txt'] });
      await setEnabled(true);

      expect(text).not.toContain('CALLER_IDENTITY_REQUIRED');
      expect(text).toMatch(/relative.*no active folder/i);
      expect(text).toContain('(none approved)');
    });

  it.each([true, false])('unattributed shutdown reaches only the permitted command runtime (allowed=%s)', async allowed => {
      await setEnabled(true, 3, allowed);
      startSwarm(1);
      const worker = startWorker('worker-1');
      finishAgent(worker.caller, 'Sleeping');
      expect(releaseQuiescentRun()).toBe(true);
      await mcpState.endpoint.stop();
      let commandEnabled = true;
      mcpState.endpoint = await startMcpServer(() => ({ roots: [{ name: 'probe', path: dir }],
        caps: { ...DEFAULT_CAPABILITIES, command: commandEnabled }, readOnly: false, sessionTools: false, agentTools: true }));
      const { unifiedExecManager } = await import('../../backend/domains/workspace/execution/manager.js');
      const allocation = vi.spyOn(unifiedExecManager, 'allocateProcessId').mockReturnValue(77777);
      // Never invoke the OS shutdown: intercept the process boundary and inspect its arguments.
      const execution = vi.spyOn(unifiedExecManager, 'execCommand').mockResolvedValue({ chunkId: 'shutdown-test', wallTimeMs: 0,
        rawOutput: Buffer.from('shutdown intercepted'), truncationPolicy: { kind: 'tokens', tokens: 1000 },
        maxOutputTokens: 1000, processId: null, exitCode: 0, originalTokenCount: null, outputOmittedBytes: null });
      try {
        const args = { cmd: 'shutdown.exe /s /t 0', workdir: '/probe' };
        const reply = await callTool('exec_command', args);
        if (allowed) {
          expect(reply).toContain('shutdown intercepted');
          expect(execution).toHaveBeenCalledWith(expect.objectContaining({ cwd: dir, hookCommand: args.cmd }));
          execution.mockClear();
          commandEnabled = false;
          await callTool('exec_command', args);
          expect(execution).not.toHaveBeenCalled();
        } else {
          expect(reply).toContain('CALLER_IDENTITY_REQUIRED');
          expect(execution).not.toHaveBeenCalled();
        }
      } finally { execution.mockRestore(); allocation.mockRestore(); await setEnabled(true); }
    });
});

