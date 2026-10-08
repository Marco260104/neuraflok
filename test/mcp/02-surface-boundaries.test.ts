import {
  BROWSER_READ_TOOLS,
  BROWSER_TOOLS,
  IS_WINDOWS,
  REASONING_EFFORTS,
  SURFACE_LIST,
  WINDOWS_COMPUTER_METHODS,
  WINDOWS_COMPUTER_READ_METHODS,
  allCaps,
  call,
  core,
  desktop,
  failed,
  fs,
  path,
  startMcpServer,
  surfaceDefinition,
  textOf,
  toolList,
  toolNames,
  withCaps,
} from './context.js';
import { mcpHarness } from './context.js';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// --------------------------------------------------------------------------- The design this whole redesign exists for. ---------------------------------------------------------------------------

describe('surface boundaries', () => {
  /** Turns everything on, so each surface advertises the most it ever can. */
  const everything = (): void => {
    mcpHarness.ctx.caps = allCaps();
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.sessionTools = true;
    mcpHarness.ctx.agentTools = true;
  };

  it('advertises exactly Core’s tools on Core, with nothing from Desktop', async () => {
    everything();
    const names = toolNames(await core('tools/list'));
    // find is absent because exec_command is present — they are mutually exclusive.
    expect(names).toEqual(['agents', 'apply_patch', 'exec', 'exec_command', 'read', 'update_plan', 'view_image', 'write_stdin']);
    for (const name of surfaceDefinition('desktop').tools.filter(name => name !== 'exec')) expect(names, name).not.toContain(name);
  });

  it('rejects the removed file-saving tool even when every permission is enabled', async () => {
    everything();
    const reply = await core('tools/call', { name: 'download_artifact', arguments: {} });
    expect(failed(reply)).toBe(true);
  });

  /** Workers inherit their chat identity, so tool schemas do not accept a model-supplied agent key. */
  const keyFields = async (surface: 'core' | 'desktop'): Promise<string[]> => {
    return toolList(await call(surface, 'tools/list'))
      .filter((tool) => {
        const properties = Object.keys(tool.inputSchema?.properties ?? {});
        return properties.some((name) => name === 'agent_key' || name.endsWith('_key')) && tool.name !== 'agents';
      })
      .map((tool) => tool.name as string);
  };

  it('offers no key field on any tool, with multi-agent fully on', async () => {
    everything();
    expect(await keyFields('core')).toEqual([]);
    expect(await keyFields('desktop')).toEqual([]);

    // Agents inherit their owning conversation identity and cannot choose a different owner.
    const agentsTool = toolList(await core('tools/list')).find((tool) => tool.name === 'agents')!;
    for (const field of Object.keys(agentsTool.inputSchema.properties)) {
      expect(field, field).not.toMatch(/key|secret|token/i);
    }

    // And an ordinary read from a worker's chat carries nothing at all.
    const call1 = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(failed(call1)).toBe(false);
  });

  /** The prime has to be able to say which model each worker gets — issue #67. The broker has accepted per-worker `model` and `reasoning_effort` for a while, validates both before creating anything, and has tests for the rejection path. What it did not have was any way for a caller to send them: the `workers` object is `.strict()`, so a spawn naming a model was rejected outright rather than honoured. This asserts the surface, since that gate is the one seam the broker's own tests cannot see. */
  it('lets a spawn choose a model and reasoning level per worker', async () => {
    everything();
    const agentsTool = toolList(await core('tools/list')).find((tool) => tool.name === 'agents')!;
    const worker = agentsTool.inputSchema.properties.workers.items;

    expect(Object.keys(worker.properties).sort()).toEqual(['label', 'model', 'reasoning_effort', 'task']);
    // Only `task` is required: omitting both keeps exactly the previous behaviour, which is the account default, or whatever the user chose in settings.
    expect(worker.required).toEqual(['task']);
    expect(worker.additionalProperties).toBe(false);

    // Declared as an enum so the caller can discover the vocabulary instead of guessing at it and having the spawn fail. `pro` belongs here: a worker is a real provider conversation.
    expect(worker.properties.reasoning_effort.enum).toEqual([...REASONING_EFFORTS]);
    expect(worker.properties.model.type).toBe('string');

    // The task description used to tell the model the opposite — that model and reasoning were fixed in app settings. A caller that believes that will never pass either field.
    expect(worker.properties.task.description).not.toMatch(/predefined by the user/i);
    for (const field of ['model', 'reasoning_effort']) {
      expect(worker.properties[field].description, field).toMatch(/app settings/i);
    }
  });

  it('preserves the existing agents guidance while adding only the cross-prime address parameter', async () => {
    everything();
    const agentsTool = toolList(await core('tools/list')).find((tool) => tool.name === 'agents')!;
    expect(agentsTool.description).toBe(
      'Run NEURAFLOK worker chats. Omit model and reasoning_effort unless the user explicitly requests an override; saved app defaults apply. Do not ask the user to choose them. Reuse a suitable sleeping worker with message before spawn. ' +
      'message: prime↔worker. Reports ride tool results, never restart primes. Use status once to collect pending reports before finalizing; otherwise state that review is pending. Never poll repeatedly. ' +
      'status: your active, sleeping/revivable and terminal workers, including parked families. finish: record the report, then normally sleep.'
    );
    expect(agentsTool.inputSchema.properties.run_id.description).toBe(
      'Select your returned worker family when status lists several; never grants another caller’s workers.'
    );
    expect(agentsTool.inputSchema.properties.context.description).toBe(
      'spawn: shared instructions prepended to every task, e.g. repo, conventions, edit limits and validation.'
    );
    expect(agentsTool.inputSchema.properties.workers.description).toBe(
      'spawn: fresh workers to create only after checking status for a suitable sleeping worker; revive one explicitly with message.'
    );
    expect(agentsTool.inputSchema.properties.messages.description).toBe(
      'message: atomic batch; prefer this to one call per recipient.'
    );
    expect(agentsTool.inputSchema.properties.to.description).toBe(
      'message: one recipient; messaging a sleeping worker wakes it.'
    );
    expect(agentsTool.inputSchema.properties.result.description).toBe(
      'finish: factual handoff under RESULT / CHANGES / VALIDATION / BLOCKERS.'
    );
    const targetRun = agentsTool.inputSchema.properties.target_run_id;
    expect(targetRun.description).toBe(
      'message: existing prime run id; prime-only, no worker/status access.'
    );
    expect(targetRun).toMatchObject({ type: 'string', minLength: 1, maxLength: 36 });
    const worker = agentsTool.inputSchema.properties.workers.items;
    // The prime is asked to name every worker: the Sub-agents list shows that name, or a generic "Worker 2".
    expect(worker.properties.label.description).toBe('Name its job in 1-3 words, e.g. "Tests"; shown to the user.');
    expect(worker.properties.task.description).toBe(
      'This worker\'s job: objective, relevant files, constraints and expected handoff.'
    );
    expect(worker.properties.model.description).toBe(
      'Omit unless explicitly requested by the user; app settings supply defaults. Use an exact account-observed model id or provider alias. Invalid overrides return observed ids before opening; the browser confirms availability before Send.'
    );
    expect(worker.properties.reasoning_effort.description).toBe(
      'Omit unless explicitly requested by the user; app settings supply defaults. Do not ask just to spawn a worker. This selects reasoning only, never a model.'
    );
    const targetRunOverhead = Buffer.byteLength(
      `,"target_run_id":${JSON.stringify(agentsTool.inputSchema.properties.target_run_id)}`,
      'utf8'
    );
    expect(targetRunOverhead).toBe(148);
    // A sleeping worker woken for new work can be renamed for it (the Sub-agents list shows the name).
    const revivalLabel = agentsTool.inputSchema.properties.messages.items.properties.label;
    expect(revivalLabel.description).toBe('New job name when waking.');
    expect(Buffer.byteLength(`,"label":${JSON.stringify(revivalLabel)}`, 'utf8')).toBe(97);
  });

  it('removes the agents tool entirely once multi-agent is switched off', async () => {
    everything();
    expect(toolNames(await core('tools/list'))).toContain('agents');

    // The user switches the feature off and reconnects the connector, which is the one reload the design is allowed to ask for. A fresh endpoint is what that reconnection looks like from here.
    mcpHarness.ctx.agentTools = false;
    await mcpHarness.endpoint.stop();
    mcpHarness.endpoint = await startMcpServer(() => mcpHarness.ctx);

    expect(toolNames(await core('tools/list'))).not.toContain('agents');
    // And with it every word of the multi-agent vocabulary: nothing is left for a model to aim a spawn or a handoff at.
    for (const surface of [toolList(await core('tools/list')), toolList(await desktop('tools/list'))]) {
      expect(JSON.stringify(surface)).not.toMatch(/prime|worker|swarm/i);
    }
  });

  it('advertises exactly Desktop’s tools on Desktop, with nothing from Core', async () => {
    everything();
    const names = toolNames(await desktop('tools/list'));
    expect(names).toEqual([...BROWSER_TOOLS, ...(IS_WINDOWS ? [...WINDOWS_COMPUTER_METHODS, 'read_clipboard', 'write_clipboard', 'exec'] : process.platform === 'darwin' ? ['computer', 'exec', 'observe'] : ['exec'])].sort());
    for (const name of surfaceDefinition('core').tools.filter(name => name !== 'exec')) expect(names, name).not.toContain(name);
  });

  it('does not let Desktop discovery freeze Core’s mutually-exclusive tool shape', async () => {
    // Each client surface keeps an independent tools/list snapshot.
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ search: true, screen: true });
    expect(toolNames(await desktop('tools/list'))).toEqual([...BROWSER_READ_TOOLS, ...(IS_WINDOWS ? [...WINDOWS_COMPUTER_READ_METHODS, 'exec'] : process.platform === 'darwin' ? ['exec', 'observe'] : ['exec'])].sort());

    // Before Core's first discovery the user enables command execution. Core should make its one-time find-vs-exec choice from *this* state, not the state Desktop happened to observe earlier.
    mcpHarness.ctx.caps = withCaps({ search: true, command: true, screen: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('exec_command');
    expect(names).toContain('write_stdin');
    expect(names).not.toContain('find');
  });

  it('never advertises a tool its surface does not declare', async () => {
    everything();
    for (const surface of SURFACE_LIST) {
      const declared = new Set(surface.tools);
      for (const name of toolNames(await call(surface.id, 'tools/list'))) {
        expect(declared.has(name), `${surface.id} advertised ${name}`).toBe(true);
      }
    }
  });

  it('leaks no Desktop schema text into a no-query Core discovery, and vice versa', async () => {
    everything();
    const coreBody = JSON.stringify((await core('tools/list')).body);
    const desktopBody = JSON.stringify((await desktop('tools/list')).body);

    // Not just the names: the action vocabulary of the other surface must be absent too, because a schema fragment is what a discovery pull actually costs. Match complete vocabulary words: "account-observed" is not the Desktop action "observe".
    for (const marker of ['computer', 'observe', 'click_ref', 'captureAfter', 'write_clipboard']) {
      expect(coreBody, marker).not.toMatch(new RegExp(`\\b${marker}\\b`));
    }
    for (const marker of ['apply_patch', 'exec_command', 'write_stdin', 'save_handoff', 'Begin Patch']) {
      expect(desktopBody, marker).not.toContain(marker);
    }
  });

  it('fails a cross-surface tools/call as an unknown tool rather than forwarding it', async () => {
    everything();
    // Core has no `computer` handler registered at all, so this must die in the protocol layer. If this ever starts succeeding, the split has become decoration.
    const onCore = await core('tools/call', { name: 'computer', arguments: { actions: [{ type: 'wait', ms: 0 }] } });
    expect(failed(onCore)).toBe(true);
    expect(JSON.stringify(onCore.body)).not.toContain('Done:');

    const onDesktop = await desktop('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(failed(onDesktop)).toBe(true);
    expect(textOf(onDesktop)).not.toContain('export const name');
    expect(JSON.stringify(onDesktop.body)).not.toContain('export const name');
  });

  it('has retired every tool name the old surface published', async () => {
    everything();
    const retired = [
      'list_roots',
      'read_file',
      'read_files',
      'list_directory',
      'search_files',
      'file_info',
      'create_file',
      'write_file',
      'write_binary_file',
      'edit_file',
      'edit_files',
      'move_path',
      'delete_file',
      'delete_directory',
      'run_command',
      'run_powershell',
      ...(!IS_WINDOWS ? ['launch_app', 'list_windows', 'read_clipboard', 'write_clipboard'] : ['observe', 'computer']),
      'open_url',
      'process',
      'screenshot',
      'wait_for_window',
      'find_ui',
      'resume_session',
      'session_history',
      'session_status',
      'save_handoff',
      'spawn_agents',
      'join_agent',
      'agent_message',
      'agent_status',
      'agent_inbox',
      'finish_agent'
    ];
    const advertised = new Set([...toolNames(await core('tools/list')), ...toolNames(await desktop('tools/list'))]);
    for (const name of retired) expect(advertised.has(name), name).toBe(false);

    // No aliases either. A retired name must be unknown to both servers, not silently accepted by the one that used to own it.
    for (const name of ['read_file', 'edit_file', 'screenshot', 'join_agent']) {
      expect(failed(await core('tools/call', { name, arguments: {} })), name).toBe(true);
      expect(failed(await desktop('tools/call', { name, arguments: {} })), name).toBe(true);
    }
  });

  it('reads the user\'s own Skills read-only through /user-skills, and nothing else in their homes', async () => {
    everything();
    const home = path.join(mcpHarness.base, 'user-skills-home');
    await fs.mkdir(path.join(home, '.claude/skills/review'), { recursive: true });
    await fs.writeFile(path.join(home, '.claude/skills/review/SKILL.md'), '---\nname: Review\n---\nRead the whole diff first.');
    await fs.mkdir(path.join(home, '.neural-jam'), { recursive: true });
    await fs.writeFile(path.join(home, '.neural-jam/credentials.json'), '{"token":"secret-token"}');
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('CLAUDE_CONFIG_DIR', ''); vi.stubEnv('NEURAFLOK_HOME', '');
    try {
      const reply = await core('tools/call', { name: 'read', arguments: { paths: ['/user-skills/claude/skills/review/SKILL.md'] } });
      expect(reply.body.result?.isError).toBeFalsy();
      expect(JSON.stringify(reply.body.result?.content)).toContain('Read the whole diff first.');
      const listing = await core('tools/call', { name: 'read', arguments: { paths: ['/user-skills/claude/skills'] } });
      expect(JSON.stringify(listing.body.result?.content)).toContain('review');
      const secret = await core('tools/call', { name: 'read', arguments: { paths: ['/user-skills/neural-jam/credentials.json'] } });
      expect(JSON.stringify(secret.body.result?.content)).not.toContain('secret-token');
      const patch = '*** Begin Patch\n*** Update File: /user-skills/claude/skills/review/SKILL.md\n@@\n-Read the whole diff first.\n+Skip the diff.\n*** End Patch';
      const patched = await core('tools/call', { name: 'apply_patch', arguments: { patch } });
      expect(patched.body.result?.isError).toBe(true);
      expect(await fs.readFile(path.join(home, '.claude/skills/review/SKILL.md'), 'utf8')).toContain('Read the whole diff first.');
    } finally { vi.unstubAllEnvs(); }
  });

  it('keeps the worst-case no-query discovery of each surface small', async () => {
    everything();
    const coreTools = toolList(await core('tools/list'));
    const desktopTools = toolList(await desktop('tools/list'));

    // Each populated surface includes code mode; find and the shell exec pair remain exclusive.
    expect(coreTools).toHaveLength(8);
    expect(desktopTools).toHaveLength(BROWSER_TOOLS.length + (IS_WINDOWS ? 16 : process.platform === 'darwin' ? 3 : 1));

    // And the size, which is what a discovery pull actually costs the model on every conversation that touches the connector. The ceilings sit just above what the surface measures today, including the eight extension browser tools, rather than at a round number well above it: a budget with room to spare is a budget that never catches the regression it exists to catch.
    const coreBytes = Buffer.byteLength(JSON.stringify(coreTools), 'utf8');
    const desktopBytes = Buffer.byteLength(JSON.stringify(desktopTools), 'utf8');
    expect(coreBytes, `core tools/list is ${coreBytes} bytes`).toBeLessThan(20_500);
    expect(desktopBytes, `desktop tools/list is ${desktopBytes} bytes`).toBeLessThan(IS_WINDOWS ? 24_000 : 24_500);

    // Per tool as well as per surface, so one schema cannot quietly eat the whole budget while the total stays under it. `computer` is the largest by design: sixteen discriminated action variants, each spelling out its own arguments, is what keeps its validation errors small and its action set explicit. `exec_command` earns a narrow exception for the `cmds` contract that removes whole connector round trips, including the one-shell and per-command-exit semantics. `agents` is the other exception: its description is where the prime learns to write shared context once instead of per worker, to batch messages into one call, and to hand back RESULT/CHANGES/VALIDATION/BLOCKERS — bytes spent once at discovery to save a great many in every run that follows.
    for (const tool of [...coreTools, ...desktopTools]) {
      const bytes = Buffer.byteLength(JSON.stringify(tool), 'utf8');
      const budget =
        (BROWSER_TOOLS as readonly string[]).includes(tool.name)
          ? (tool.name === 'browser_action' ? 4_300 : 2_300)
          : IS_WINDOWS && desktopTools.includes(tool)
          // Largest Window2 method is click at 882 bytes; composition is 1458 bytes.
          ? (tool.name === 'exec' ? 1_500 : 950)
          : tool.name === 'computer'
          // Retain the existing legacy schema allowance on macOS.
          ? 7_400
          : tool.name === 'apply_patch'
            ? 5_000
            : tool.name === 'agents'
              // Main's 3,400-byte guardrail plus the measured 148-byte target_run_id property and the measured 97-byte revival label (messages[].label).
              ? 3_645
              : tool.name === 'exec_command'
                // Windows includes fixed shell guidance, so assert its size separately from our additions.
                ? (process.platform === 'win32' ? 3_800 : 3_500)
                : 3_000;
      expect(bytes, `${tool.name} schema is ${bytes} bytes`).toBeLessThan(budget);
    }
  });

  it('describes both surfaces well enough for a user to set them up and a model to find them', () => {
    for (const surface of SURFACE_LIST) {
      expect(surface.serverName, surface.id).toMatch(/^neuraflok-/);
      expect(surface.connectorName, surface.id).toContain('NEURAFLOK');
      expect(surface.cardSummary.length, surface.id).toBeGreaterThan(20);
      // The description is the only thing the model has before discovery, so it has to carry real vocabulary rather than a label.
      expect(surface.description.length, surface.id).toBeGreaterThan(120);
      expect(surface.tools.length, surface.id).toBeGreaterThan(0);
    }
    expect(surfaceDefinition('core').required).toBe(true);
    expect(surfaceDefinition('desktop').required).toBe(false);
    // Distinct names, because the connector name is also the retrieval handle.
    expect(surfaceDefinition('core').connectorName).not.toBe(surfaceDefinition('desktop').connectorName);
  });

  it('gives each surface its own server identity and instructions', async () => {
    everything();
    for (const surface of SURFACE_LIST) {
      const reply = await call(surface.id, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      });
      expect(reply.body.result.serverInfo.name, surface.id).toBe(surface.serverName);
      expect(reply.body.result.instructions, surface.id).toBeTruthy();
    }
  });
});
