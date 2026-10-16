import {
  IS_WINDOWS,
  core,
  desktop,
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
} from 'vitest';

describe('2025-era clients', () => {
  it('answers the initialize handshake', async () => {
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    expect(reply.status).toBe(200);
    expect(reply.body.result.serverInfo.name).toBe('neuraflok-core');
    expect(reply.body.result.protocolVersion).toBeTruthy();
  });

  it('exposes the Core server instructions', async () => {
    mcpHarness.ctx.caps = withCaps({ read: true, command: true });
    mcpHarness.ctx.readOnly = false;
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    const instructions: string = reply.body.result.instructions ?? '';
    expect(instructions).toContain('/workspace');
    expect(instructions).toContain('start_line/end_line range applies to every file the call reads');
    if (IS_WINDOWS) {
      // The Windows glob gap, taught once here because it is what most shell retries were for.
      expect(instructions).toContain('PowerShell does not expand * or ? for native programs');
    } else {
      expect(instructions).toContain('normal POSIX shell');
      expect(instructions).not.toContain('PowerShell does not expand * or ? for native programs');
    }
    // NEURAFLOK's collaboration rules stay at server level instead of bloating tool descriptions.
    expect(instructions).toContain('For long tasks, send a short progress update while continuing useful work.');
    // The two round-trip levers the recorded sessions actually pay for. Both are instructions rather than tool descriptions because they are about *how many calls to make*, which is a decision taken before any one tool's schema is read.
    expect(instructions).toContain('exec_command cmds');
    expect(instructions).toContain('Read whole files for orientation');
    expect(instructions).toContain('Read project guidance files such as AGENTS.md');
    expect(instructions).not.toContain('/workspace/src/main.ts');
    expect(instructions).not.toMatch(/functions\.|request_user_input|approval auto-review/);
    expect(instructions).toContain('/skills/<id>/SKILL.md');
    // Follow-up instructions keep earlier task constraints active within the same chat.
    expect(instructions).toContain('A user\'s follow-up extends the active objective; retain earlier constraints and corrections until explicitly replaced.');
    expect(instructions).toContain(
      'Current Core authority (informational; live guards decide): ' +
      'browse=on search=on read=on metadata=on create=off edit=off move=off delete=off command=on; ' +
      'read-only=off; plans=off; workers=off.'
    );
    expect(instructions).not.toContain(mcpHarness.approved);
    expect(instructions.length).toBeLessThan(18_000);
  });

  it('keeps provider and desktop surface guidance independent', async () => {
    mcpHarness.ctx.caps = withCaps({ screen: true, control: true });
    mcpHarness.ctx.readOnly = false;
    const coreReply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    expect(coreReply.body.result.instructions).toContain("NEURAFLOK's coding assistant");
    expect(coreReply.body.result.instructions).not.toContain('ChatGPT');

    const desktopReply = await desktop('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    expect(desktopReply.body.result.instructions).not.toContain('ChatGPT');
    if (IS_WINDOWS) {
      expect(desktopReply.body.result.instructions).toContain('get_window_state');
      expect(desktopReply.body.result.instructions).toContain('sky');
    } else if (process.platform === 'darwin') {
      expect(desktopReply.body.result.instructions).toContain('observe');
      expect(desktopReply.body.result.instructions).toContain('Do not poll with a batch that only waits');
      expect(desktopReply.body.result.instructions).toContain('verify');
    } else {
      expect(desktopReply.body.result.instructions).toContain('browser_snapshot');
      expect(toolNames(await desktop('tools/list'))).not.toContain('observe');
      expect(toolNames(await desktop('tools/list'))).not.toContain('computer');
    }
  });

  it('lists tools without an initialize handshake', async () => {
    const reply = await core('tools/list');
    expect(reply.status).toBe(200);
    expect(toolNames(reply)).toContain('read');
  });

  it('calls a tool', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    expect(reply.status).toBe(200);
    expect(textOf(reply)).toContain('export const name = "app";');
  });

  it('exposes local image inspection as native MCP image content', async () => {
    const tool = toolList(await core('tools/list')).find((entry) => entry.name === 'view_image');
    const schema = tool?.inputSchema;
    expect(Object.keys(schema?.properties ?? {})).toEqual(['path']);
    expect(schema?.required).toEqual(['path']);
    expect(schema?.additionalProperties).toBe(false);
    expect(tool?.outputSchema).toBeUndefined();

    const reply = await core('tools/call', {
      name: 'view_image',
      arguments: { path: '/workspace/pixel.png' }
    });
    expect(reply.status).toBe(200);
    const content = reply.body.result?.content as Array<Record<string, unknown>>;
    const image = content.find((item) => item.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(typeof image?.data).toBe('string');
    expect(Buffer.from(String(image?.data), 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(reply.body.result?.structuredContent).toBeUndefined();
  });
});
