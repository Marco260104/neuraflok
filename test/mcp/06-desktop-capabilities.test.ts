import {
  BROWSER_READ_TOOLS,
  IS_WINDOWS,
  WINDOWS_COMPUTER_METHODS,
  WINDOWS_COMPUTER_READ_METHODS,
  core,
  defaultConfig,
  desktop,
  effectiveCapabilities,
  failed,
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

describe('desktop capabilities', () => {
  it('advertises nothing until a desktop permission is turned on', async () => {
    mcpHarness.ctx.readOnly = false;
    expect(toolNames(await desktop('tools/list'))).toEqual([]);
  });

  it('offers looking at the screen without offering control of it', async () => {
    mcpHarness.ctx.caps = withCaps({ screen: true });
    const names = toolNames(await desktop('tools/list'));
    expect(names).toEqual([...BROWSER_READ_TOOLS, ...(IS_WINDOWS ? [...WINDOWS_COMPUTER_READ_METHODS, 'exec'] : process.platform === 'darwin' ? ['exec', 'observe'] : ['exec'])].sort());
  });

  // Seeing the screen changes nothing, so it survives read-only mode; driving the mouse and keyboard can do anything the user can, so it must not.
  it('keeps seeing but not touching in read-only mode', async () => {
    // Exercise the read-only capability split on a platform with a native Desktop backend rather than making the result depend on the CI host.
    const config = { ...defaultConfig('win32'), capabilities: withCaps({ screen: true, control: true }) };

    mcpHarness.ctx.readOnly = true;
    mcpHarness.ctx.caps = effectiveCapabilities({ ...config, readOnly: true }, 'win32');
    expect(mcpHarness.ctx.caps.screen).toBe(true);
    expect(mcpHarness.ctx.caps.control).toBe(false);
    expect(toolNames(await desktop('tools/list'))).toEqual([...BROWSER_READ_TOOLS, ...(IS_WINDOWS ? [...WINDOWS_COMPUTER_READ_METHODS, 'exec'] : process.platform === 'darwin' ? ['exec', 'observe'] : ['exec'])].sort());

    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = effectiveCapabilities({ ...config, readOnly: false }, 'win32');
    expect(toolNames(await desktop('tools/list'))).toContain(IS_WINDOWS ? 'click' : process.platform === 'darwin' ? 'computer' : 'browser_action');
  });

  it('offers clipboard access alone and refuses operations whose permission is revoked', async () => {
    mcpHarness.ctx.readOnly = false;
    // Publish the schema once, then exercise live revocation on the same endpoint.
    mcpHarness.ctx.caps = withCaps({ screen: true, control: true, clipboardRead: true, clipboardWrite: true });
    await desktop('tools/list');
    mcpHarness.ctx.caps = withCaps({ control: false, clipboardRead: true, clipboardWrite: false });

    const clicked = await desktop('tools/call', {
      name: IS_WINDOWS ? 'click' : 'computer',
      arguments: IS_WINDOWS ? { window: { app: 'fixture.exe', id: 1 }, x: 5, y: 5 } : { actions: [{ type: 'click', x: 5, y: 5 }] }
    });
    if (!IS_WINDOWS && process.platform !== 'darwin') {
      expect(failed(clicked)).toBe(true);
      expect(clicked.body.error?.message).toMatch(/unknown|not found/i);
      expect(toolNames(await desktop('tools/list'))).not.toContain('computer');
      return;
    }
    expect(clicked.body.result?.isError).toBe(true);
    expect(textOf(clicked)).toContain(IS_WINDOWS ? 'TOOL_DISABLED' : 'mouse and keyboard control is disabled');

    const written = await desktop('tools/call', {
      name: IS_WINDOWS ? 'write_clipboard' : 'computer',
      arguments: IS_WINDOWS ? { text: 'nope' } : { actions: [{ type: 'write_clipboard', text: 'nope' }] }
    });
    expect(written.body.result?.isError).toBe(true);
    expect(textOf(written)).toContain(IS_WINDOWS ? 'TOOL_DISABLED' : 'Replace clipboard text permission');
  });

  it('publishes only the clipboard read tool and composition with clipboard-read permission alone', async () => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ clipboardRead: true });
    expect(toolNames(await desktop('tools/list'))).toEqual(IS_WINDOWS ? ['exec', 'read_clipboard'] : process.platform === 'darwin' ? ['computer', 'exec'] : []);
  });

  it('marks observing read-only and control destructive', async () => {
    mcpHarness.ctx.caps = withCaps({ screen: true, control: true });
    mcpHarness.ctx.readOnly = false;
    const tools = toolList(await desktop('tools/list'));
    const observe = tools.find((t) => t.name === (IS_WINDOWS ? 'get_window_state' : process.platform === 'darwin' ? 'observe' : 'browser_snapshot'));
    const computer = tools.find((t) => t.name === (IS_WINDOWS ? 'click' : process.platform === 'darwin' ? 'computer' : 'browser_action'));
    expect(observe?.annotations?.readOnlyHint).toBe(true);
    expect(computer?.annotations?.readOnlyHint).toBe(false);
    expect(computer?.annotations?.destructiveHint).toBe(true);
  });

  it.skipIf(!IS_WINDOWS)('publishes Window2 schemas with exact window ownership and bounded wheel deltas', async () => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ screen: true, control: true });
    const tools = toolList(await desktop('tools/list'));
    const click = tools.find(t => t.name === 'click')!.inputSchema;
    expect(click.properties.window.required).toEqual(['app', 'id']);
    expect(click.properties.element_index.type).toBe('integer');
    expect(click.properties.screenshotId.type).toBe('string');
    expect(click.properties.mouse_button.enum).toEqual(['left', 'right', 'middle', 'l', 'r', 'm']);
    const scroll = tools.find(t => t.name === 'scroll')!.inputSchema;
    expect(scroll.properties.scrollY.minimum).toBe(-1_200_000);
    expect(scroll.properties.scrollY.maximum).toBe(1_200_000);
    for (const method of WINDOWS_COMPUTER_METHODS) {
      expect(failed(await core('tools/call', { name: method, arguments: {} })), method).toBe(true);
    }
    for (const name of ['observe', 'computer']) {
      expect(failed(await desktop('tools/call', { name, arguments: {} })), name).toBe(true);
    }
  });

  it.skipIf(!IS_WINDOWS)('rejects invalid Window2 input over HTTP before native observation or input', async () => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ screen: true, control: true });
    const window = { app: 'fixture.exe', id: 1 };
    for (const [name, args] of [
      ['click', { window: { id: 1 }, x: 1, y: 1 }],
      ['click', { window, element_index: -1 }],
      ['click', { window, mouse_button: 'invalid', x: 1, y: 1 }],
      ['scroll', { window, x: 1, y: 1, scrollX: 0, scrollY: 1_200_001 }],
      ['get_window_state', { window, include_screenshot: false, include_text: false }]
    ] as const) {
      const reply = await desktop('tools/call', { name, arguments: args });
      expect(failed(reply), `${name}: ${textOf(reply)}`).toBe(true);
      expect(textOf(reply)).not.toContain('WINDOW_NOT_FOUND');
    }
    const paste = await desktop('tools/call', { name: 'type_text', arguments: { window, text: 'first\nsecond' } });
    expect(failed(paste)).toBe(true);
    expect(textOf(paste)).toContain('Replace clipboard text permission');
    mcpHarness.ctx.caps = withCaps({ control: true });
    const revoked = await desktop('tools/call', { name: 'get_window_state', arguments: { window } });
    expect(failed(revoked)).toBe(true);
    expect(textOf(revoked)).toContain('TOOL_DISABLED');
  });

  it.skipIf(process.platform !== 'darwin')('carries the clipboard actions in the computer schema rather than as tools of their own', async () => {
    mcpHarness.ctx.caps = withCaps({ screen: true, control: true, clipboardRead: true, clipboardWrite: true });
    mcpHarness.ctx.readOnly = false;
    const schema = JSON.stringify(toolList(await desktop('tools/list')).find((t) => t.name === 'computer'));
    expect(schema).toContain('read_clipboard');
    expect(schema).toContain('write_clipboard');
    expect(schema).toContain('command+v on macOS');
    expect(schema).toContain('ctrl+v on Windows/Linux');
  });

  it.skipIf(process.platform !== 'darwin')('rejects a malformed action before it reaches the desktop', async () => {
    mcpHarness.ctx.caps = withCaps({ screen: true, control: true });
    mcpHarness.ctx.readOnly = false;
    // No coordinates, so there is nothing to click; this must fail as a tool error rather than being passed on to the helper.
    const reply = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'click' }] }
    });
    expect(failed(reply)).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')('rejects unknown fields inside a desktop action instead of silently dropping them', async () => {
    mcpHarness.ctx.caps = withCaps({ control: true });
    mcpHarness.ctx.readOnly = false;
    const reply = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'wait', ms: 0, typo_that_must_not_be_ignored: true }] }
    });
    expect(failed(reply)).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')('rejects capture options that would otherwise be silently ignored', async () => {
    mcpHarness.ctx.caps = withCaps({ control: true, screen: true });
    mcpHarness.ctx.readOnly = false;
    const withoutCapture = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'wait', ms: 0 }], captureWindow: 123 }
    });
    expect(failed(withoutCapture)).toBe(true);

    const conflictingTargets = await desktop('tools/call', {
      name: 'computer',
      arguments: {
        actions: [{ type: 'wait', ms: 0 }],
        captureAfter: true,
        captureWindow: 123,
        captureFull: true
      }
    });
    expect(failed(conflictingTargets)).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')('validates compact computer postconditions and keeps screen permission live', async () => {
    mcpHarness.ctx.caps = withCaps({ control: true, screen: true });
    mcpHarness.ctx.readOnly = false;
    const malformed = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'wait', ms: 0 }], verify: { until: 'foreground' } }
    });
    expect(failed(malformed)).toBe(true);

    mcpHarness.ctx.caps = withCaps({ control: true, screen: false });
    const disabled = await desktop('tools/call', {
      name: 'computer',
      arguments: {
        actions: [{ type: 'wait', ms: 0 }],
        verify: { until: 'foreground', window: 123, timeout_ms: 0 }
      }
    });
    expect(failed(disabled)).toBe(true);
    expect(textOf(disabled)).toContain('See the screen');
  });

  it.skipIf(process.platform !== 'darwin')('rejects observe options whose selected view would silently ignore them', async () => {
    mcpHarness.ctx.caps = withCaps({ screen: true });
    const strayTimeout = await desktop('tools/call', {
      name: 'observe',
      arguments: { timeout_ms: 100 }
    });
    expect(failed(strayTimeout)).toBe(true);

    const unusedMatch = await desktop('tools/call', {
      name: 'observe',
      arguments: { what: 'active', match: 'Notepad' }
    });
    expect(failed(unusedMatch)).toBe(true);

    const impossibleShot = await desktop('tools/call', {
      name: 'observe',
      arguments: { what: 'ui', screenshot: true }
    });
    expect(failed(impossibleShot)).toBe(true);
  });
});
