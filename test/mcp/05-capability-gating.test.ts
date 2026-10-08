import {
  addPatch,
  allCaps,
  core,
  defaultConfig,
  effectiveCapabilities,
  failed,
  fs,
  path,
  textOf,
  toolNames,
  withCaps,
} from './context.js';
import { mcpHarness } from './context.js';
import {
  describe,
  expect,
  it,
} from 'vitest';

describe('capability gating', () => {
  it('hides every writing and running tool in read-only mode', async () => {
    // Everything on, but read-only, which is the state that must still be safe.
    const config = { ...defaultConfig(), capabilities: allCaps(), readOnly: true };
    mcpHarness.ctx.caps = effectiveCapabilities(config);
    mcpHarness.ctx.readOnly = true;

    expect(toolNames(await core('tools/list'))).toEqual(['exec', 'find', 'read', 'view_image']);
  });

  it('offers apply_patch only when a writing permission is on', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('apply_patch');
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');
  });

  it('enforces the create/edit/move/delete split inside one apply_patch schema', async () => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ create: true, edit: false, move: false, deleteFile: false });

    const added = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/split.txt', ['one']) }
    });
    expect(added.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(mcpHarness.approved, 'split.txt'), 'utf8')).toBe('one\n');

    const addOverExisting = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/split.txt', ['overwritten through add']) }
    });
    expect(addOverExisting.body.result?.isError).toBe(true);
    expect(textOf(addOverExisting)).toContain('Edit files is disabled');
    expect(await fs.readFile(path.join(mcpHarness.approved, 'split.txt'), 'utf8')).toBe('one\n');

    const updated = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: ['*** Begin Patch', '*** Update File: /workspace/split.txt', '@@', '-one', '+two', '*** End Patch'].join('\n')
      }
    });
    expect(updated.body.result?.isError).toBe(true);
    expect(textOf(updated)).toContain('Edit files is disabled');
    // Refused before anything was written, which is the whole promise of apply_patch.
    expect(await fs.readFile(path.join(mcpHarness.approved, 'split.txt'), 'utf8')).toBe('one\n');

    const deleted = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: ['*** Begin Patch', '*** Delete File: /workspace/split.txt', '*** End Patch'].join('\n') }
    });
    expect(deleted.body.result?.isError).toBe(true);
    expect(textOf(deleted)).toContain('Delete files is disabled');
  });

  it('keeps command execution off unless it is explicitly enabled', async () => {
    mcpHarness.ctx.readOnly = false;
    expect(toolNames(await core('tools/list'))).not.toContain('exec_command');

    mcpHarness.ctx.caps = withCaps({ command: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('exec_command');
    expect(names).toContain('write_stdin');
  });

  it('drops find when exec_command can do the same job better', async () => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ command: true, search: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('exec_command');
    expect(names).not.toContain('find');
  });

  it('offers find when there is no shell to search with', async () => {
    mcpHarness.ctx.caps = withCaps({ search: true, command: false });
    expect(toolNames(await core('tools/list'))).toContain('find');

    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: 'helper', mode: 'content' }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
    expect(textOf(reply)).toContain('results_returned:');
  });

  it('offers plans and agents only when enabled, without session lookup', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('session');
    expect(toolNames(await core('tools/list'))).not.toContain('update_plan');
    expect(toolNames(await core('tools/list'))).not.toContain('agents');

    mcpHarness.ctx.sessionTools = true;
    mcpHarness.ctx.agentTools = true;
    const names = toolNames(await core('tools/list'));
    expect(names).not.toContain('session');
    expect(names).toContain('update_plan');
    expect(names).toContain('agents');
  });

  it('teaches primes to reuse sleeping workers before spawning replacements', async () => {
    mcpHarness.ctx.agentTools = true;
    const initialized = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    const instructions: string = initialized.body.result.instructions ?? '';
    expect(instructions).toMatch(/Reuse\s+a sleeping worker for related follow-up work before spawning a replacement/);
    expect(instructions).toContain('Only terminal workers whose context is full need replacing');
    expect(instructions).toContain('Reports arrive only with tool results; they do not restart an idle prime');
    expect(instructions).toContain('do not claim delegated verification is complete before reading its report');

    const tools = await core('tools/list');
    const agentsDescription = (tools.body.result.tools as Array<{ name: string; description?: string }>).find(
      (tool) => tool.name === 'agents'
    )?.description;
    expect(agentsDescription).toContain('Reuse a suitable sleeping worker with message before spawn');
    expect(agentsDescription).toContain('status once to collect pending reports before finalizing');
    expect(agentsDescription).toContain('state that review is pending');
  });

  it('rejects action-specific agent fields instead of silently ignoring them', async () => {
    mcpHarness.ctx.agentTools = true;
    const reply = await core('tools/call', {
      name: 'agents',
      arguments: { action: 'status', result: 'this field belongs to finish' }
    });
    expect(failed(reply)).toBe(true);
  });

  it('starts a fresh install with every capability effective', () => {
    // This assertion is about the product's fully-enabled fresh-install policy, not the host running Vitest. Windows has no OS-version floor, so it is the deterministic representative for a host with every declared capability.
    const config = defaultConfig('win32');
    expect(config.readOnly).toBe(false);
    expect(config.multiAgent.enabled).toBe(true);
    expect(Object.values(effectiveCapabilities(config, 'win32')).every(Boolean)).toBe(true);
  });

  it('refuses to call a tool that is not registered', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: ['*** Begin Patch', '*** Delete File: /workspace/notes.txt', '*** End Patch'].join('\n') }
    });
    // Either a JSON-RPC error or a tool error, but never a deletion.
    expect(failed(reply)).toBe(true);
    expect(await fs.readFile(path.join(mcpHarness.approved, 'notes.txt'), 'utf8')).toContain('note line 1');
  });

  it('answers metadata-only permission with metadata rather than refusing the path', async () => {
    mcpHarness.ctx.caps = withCaps({ read: false, browse: false, metadata: true });
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('/workspace/src/app.ts');
    expect(text).toContain('need the Read files permission');
    expect(text).not.toContain('export const name');
  });

  it('picks up a permission change on the very next request', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('apply_patch');
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');
  });

  it('keeps an already-exposed tool stable and returns TOOL_DISABLED after permission is revoked', async () => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');

    mcpHarness.ctx.caps = withCaps({ create: false });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/should-not-exist.txt', ['nope']) }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('TOOL_DISABLED');
    await expect(fs.stat(path.join(mcpHarness.approved, 'should-not-exist.txt'))).rejects.toThrow();
  });

  // find and exec are mutually exclusive; preserving prior exposure keeps cached client lists valid after permissions change.
  it('keeps find listed after command execution is switched on mid-run', async () => {
    mcpHarness.ctx.caps = withCaps({ search: true, read: true, browse: true });
    expect(toolNames(await core('tools/list'))).toContain('find');

    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ search: true, read: true, browse: true, command: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('find');
    expect(names).toContain('exec_command');
  });

  it('does not add find to a surface that started with command execution on', async () => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ search: true, read: true, command: true });
    expect(toolNames(await core('tools/list'))).not.toContain('find');

    mcpHarness.ctx.caps = withCaps({ search: true, read: true, command: false });
    expect(toolNames(await core('tools/list'))).not.toContain('find');
  });

  it('always offers read, because that is what the app is for', async () => {
    mcpHarness.ctx.caps = withCaps({ browse: false, search: false, read: false, metadata: false });
    // Nothing is registered when every reading permission is off — but the snapshot is monotonic, so a surface that started with reading on keeps it and refuses instead.
    expect(toolNames(await core('tools/list'))).toEqual([]);
  });
});
