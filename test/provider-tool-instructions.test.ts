/** Tests that user instructions append without replacing the connector contract. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { MAX_PROVIDER_TOOL_INSTRUCTIONS_CHARS, defaultConfig, getConfig, initConfigPath, saveConfig } = await import(
  '../backend/infrastructure/settings/config.js'
);
const { serverInstructions } = await import('../backend/infrastructure/tool-gateway/protocol/instructions.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');
const { CAPABILITIES } = await import('../contracts/types.js');
type Capabilities = import('../contracts/types.js').Capabilities;

let dir: string;

const allCapabilities = (): Capabilities =>
  Object.fromEntries(CAPABILITIES.map((name) => [name, true])) as Capabilities;

const ctx = {
  roots: [],
  caps: allCapabilities(),
  readOnly: false,
  sessionTools: false,
  agentTools: false
};

const HEADING = "The user's own standing instructions for local tools:";

async function withInstructions(instructions: string): Promise<void> {
  const config = getConfig();
  await saveConfig({ ...config, providerTools: { ...config.providerTools, instructions } });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-provider-tool-instructions-');
  initConfigPath(dir);
  await saveConfig(defaultConfig());
});

afterAll(async () => {
  await removeTempDir(dir);
});

beforeEach(async () => {
  await withInstructions('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the user’s own provider tool guidance', () => {
  it.each([
    [true, true, false, 'file writing and exec_command'],
    [true, false, false, 'file writing'],
    [false, true, false, 'exec_command'],
    [false, false, false, null],
    [true, true, true, null],
  ] as const)('affirms only enabled local capabilities (write=%s command=%s readOnly=%s)', (write, command, readOnly, expected) => {
    const text = serverInstructions({ ...ctx, readOnly, caps: {
      ...ctx.caps, create: write, edit: write, move: write, deleteFile: write, command,
    } }, 'core', 'win32');
    const assertion = text.split('\n').find(line => line.startsWith('You can always use '));
    if (expected) {
      expect(assertion).toBe(`You can always use ${expected} in NEURAFLOK. Report the exact refusal instead of guessing which system blocked a call.`);
    } else expect(assertion).toBeUndefined();
  });
  it.each(['win32', 'darwin', 'linux'] as const)('teaches the same terminal result lifetime on %s', platform => {
    const text = serverInstructions({ ...ctx, caps: { ...ctx.caps, command: true } }, 'core', platform);
    expect(text).toContain('completed_session_id');
    expect(text).toContain('benign_exit');
    expect(text).toContain('without rerunning work');
    if (platform !== 'win32') {
      expect(text).toContain('normal POSIX shell');
      expect(text).not.toContain('Pipe foreach output');
    }
  });
  it('starts with local tool guidance without a remote setup link', () => {
    const text = serverInstructions(ctx, 'core', 'win32');
    expect(text.startsWith("You are NEURAFLOK's coding assistant in a local workspace.")).toBe(true);
    const intro = text.split('\n').find(line => line.startsWith('Use the local tools listed in this provider conversation'))!;
    expect(intro).toContain('Use the local tools listed in this provider conversation');
    expect(text.indexOf(intro)).toBeGreaterThan(text.indexOf('# Local tools'));
    expect(text).not.toMatch(/ChatGPT|https:\/\/chatgpt.com\/#settings\/Plugins/);
    expect(serverInstructions(ctx, 'core', 'linux')).not.toContain('Desktop connector');
  });
  it('routes Linux browser users to Core for files without advertising native desktop tools', () => {
    const text = serverInstructions(ctx, 'desktop', 'linux');
    expect(text).toContain('browser_snapshot');
    expect(text).toContain('Files and shell commands are local workspace tools.');
    expect(text).not.toContain('get_window_state');
    expect(text).not.toContain('Do not poll with a batch that only waits');
  });
  it('uses NEURAFLOK guidance and advertises only currently available tools', () => {
    const text = serverInstructions(ctx, 'core', 'win32');
    expect(text).toContain('Continue until each requested outcome is complete or name the precise blocker.');
    expect(text).toContain('Read project guidance files such as AGENTS.md and enabled Skills before changing code');
    expect(text).not.toMatch(/functions\.|tool_search|approval auto-review|user-requested computer shutdown/);
    expect(text).toContain('/skills/<id>/SKILL.md');
    expect(text).not.toContain('Use update_plan');
    const recorded = serverInstructions({ ...ctx, sessionTools: true }, 'core', 'win32');
    expect(recorded).toContain('Use update_plan');
    expect(recorded).not.toMatch(/session action=|update_cursor|recorded history/);
    const withoutCommands = serverInstructions({ ...ctx, caps: { ...ctx.caps, command: false } }, 'core', 'linux');
    expect(withoutCommands).toContain('find searches');
    expect(withoutCommands).not.toContain('exec_command runs');
  });

  it('explains provider and local refusals and offers session_finish when exposed', () => {
    const text = serverInstructions({ ...ctx, exposedFinishTool: true }, 'core', 'win32');
    expect(text).toContain('A provider or local tool may refuse an action.');
    expect(text).toContain('check for side effects, and never replay an ambiguous mutation.');
    expect(text).toContain('Use session_finish only when the user prompt explicitly requests it, with any model.');
    expect(text).not.toMatch(/ChatGPT|OpenAI|Astra only/);
  });

  it('adds nothing at all when empty, not even the heading', () => {
    expect(defaultConfig().providerTools.instructions).toBe('');
    for (const surface of ['core', 'desktop'] as const) {
      const text = serverInstructions(ctx, surface, 'win32');
      expect(text, surface).not.toContain(HEADING);
    }
  });

  it.each(['core', 'desktop'] as const)('appends them last on the %s tool surface, attributed', async (surface) => {
    const mine = 'Always run the test suite before saying a change works.';
    await withInstructions(mine);

    const text = serverInstructions(ctx, surface, 'win32');
    expect(text).toContain(HEADING);
    expect(text).toContain(mine);
    // No application guidance follows the attributed user block.
    expect(text.trimEnd().endsWith(mine)).toBe(true);
    // The heading keeps the user's instructions separately attributed.
    expect(text.indexOf(HEADING)).toBeLessThan(text.indexOf(mine));
  });

  it('leaves everything the app says about itself intact', async () => {
    const before = serverInstructions(ctx, 'core', 'win32');
    await withInstructions('Prefer pnpm.');
    const after = serverInstructions(ctx, 'core', 'win32');

    // Adding a preference preserves the original tool contract byte for byte.
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toContain('Prefer pnpm.');
  });

  it('survives a reload, which is the whole point of it being a setting', async () => {
    await withInstructions('Never force-push.');
    initConfigPath(dir);
    expect(getConfig().providerTools.instructions).toBe('Never force-push.');
    expect(serverInstructions(ctx, 'core', 'win32')).toContain('Never force-push.');
  });

  it('trims surrounding whitespace rather than emitting a blank block', async () => {
    await withInstructions('   \n  \t ');
    expect(getConfig().providerTools.instructions).toBe('');
    expect(serverInstructions(ctx, 'core', 'win32')).not.toContain(HEADING);
  });

  it('caps an over-long value instead of rejecting the whole config', async () => {
    // Overlong free text is bounded without sending unrelated settings through recovery.
    await withInstructions('x'.repeat(MAX_PROVIDER_TOOL_INSTRUCTIONS_CHARS + 500));
    const stored = getConfig().providerTools.instructions;
    expect(stored.length).toBe(MAX_PROVIDER_TOOL_INSTRUCTIONS_CHARS);
    // Unrelated settings retain their saved values.
    expect(getConfig().readOnly).toBe(false);
    expect(serverInstructions(ctx, 'core', 'win32')).toContain(stored);
  });
});
