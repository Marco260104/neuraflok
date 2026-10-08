import {
  core,
  toolList,
  withCaps,
} from './context.js';
import { mcpHarness } from './context.js';
import {
  describe,
  expect,
  it,
} from 'vitest';

describe('tool annotations', () => {
  it('keeps connector annotations off upstream tool specifications', async () => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ read: true, create: true, edit: true, move: true, deleteFile: true, command: true });
    const tools = toolList(await core('tools/list'));
    for (const name of ['view_image', 'apply_patch', 'exec_command', 'write_stdin']) {
      expect(tools.find((tool) => tool.name === name)?.annotations, name).toBeUndefined();
    }
  });

  it('retains annotations on connector-native tools', async () => {
    mcpHarness.ctx.sessionTools = true;
    const read = toolList(await core('tools/list')).find((tool) => tool.name === 'read');
    expect(read?.annotations?.readOnlyHint).toBe(true);
    expect(read?.annotations?.destructiveHint).toBe(false);
  });
});
