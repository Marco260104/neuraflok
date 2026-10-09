import {
  addPatch,
  core,
  fs,
  os,
  path,
  textOf,
  toolList,
  withCaps,
} from './context.js';
import { mcpHarness } from './context.js';
import {
  describe,
  expect,
  it,
} from 'vitest';

describe('sandbox enforcement through the tool layer', () => {
  const escapes = [
    '/workspace/../private/passwords.txt',
    '/workspace/../../private/passwords.txt',
    '\\workspace\\..\\private\\passwords.txt',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    '/private/passwords.txt',
    '/workspace/notes.txt:stream'
  ];

  it('refuses every escape attempt on read', async () => {
    for (const attempt of escapes) {
      const reply = await core('tools/call', { name: 'read', arguments: { paths: [attempt] } });
      const text = textOf(reply);
      // One bad path is a per-path failure rather than a failed call, so the assertion is that the content never arrives — not that the call errored.
      expect(text, attempt).toContain('ERROR');
      expect(text, attempt).not.toContain('hunter2');
    }
  });

  it('accepts a native filesystem path when it is inside an approved root', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: [path.join(mcpHarness.approved, 'notes.txt')] }
    });
    expect(reply.body.result?.isError).not.toBe(true);
    expect(textOf(reply)).toContain('note line 1');
    expect(textOf(reply)).toContain('/workspace/notes.txt');
    expect(textOf(reply)).not.toContain(mcpHarness.approved);
  });

  it('accepts native filesystem globs through read', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: [path.join(mcpHarness.approved, 'src', '**', '*.ts')] }
    });
    expect(reply.body.result?.isError, textOf(reply)).not.toBe(true);
    expect(textOf(reply)).toContain('/workspace/src/app.ts');
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
    expect(textOf(reply)).not.toContain(mcpHarness.approved);
  });

  it('accepts a native filesystem search scope through find', async () => {
    mcpHarness.ctx.caps = withCaps({ search: true });
    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: 'helper', mode: 'content', path: path.join(mcpHarness.approved, 'src') }
    });
    expect(reply.body.result?.isError, textOf(reply)).not.toBe(true);
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
    expect(textOf(reply)).not.toContain(mcpHarness.approved);
  });

  it('accepts a native filesystem image path through view_image', async () => {
    mcpHarness.ctx.caps = withCaps({ read: true });
    const reply = await core('tools/call', {
      name: 'view_image',
      arguments: { path: path.join(mcpHarness.approved, 'pixel.png') }
    });
    expect(reply.body.result?.isError).not.toBe(true);
    const content = reply.body.result?.content as Array<Record<string, unknown>>;
    expect(content.find((item) => item.type === 'image')?.mimeType).toBe('image/png');
  });

  it('refuses escape attempts on find', async () => {
    mcpHarness.ctx.caps = withCaps({ search: true });
    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: 'hunter2', mode: 'content', path: '/workspace/../private' }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).not.toContain('hunter2\n');
  });

  it('refuses to write outside a root even with writes enabled', async () => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ create: true });
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/../private/planted.txt', ['x']) }
    });
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(mcpHarness.outside, 'planted.txt'))).rejects.toThrow();
  });

  it('refuses a relative patch path that climbs out of its base', async () => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ create: true });
    // apply_patch used to join the base onto the path and `posix.normalize` the result before the sandbox ever saw it, which erased the `..` that checkSegment exists to refuse: `/workspace/../private/planted.txt` became a clean `/private/planted.txt` and arrived looking like a path that had always been absolute. Patch paths now get the same treatment as a path handed to read or exec.
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('../private/planted.txt', ['x']) }
    });
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(mcpHarness.outside, 'planted.txt'))).rejects.toThrow();
  });

  it('does not advertise the retired apply_patch cwd argument', async () => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ create: true });
    const tool = toolList(await core('tools/list')).find((entry) => entry.name === 'apply_patch')!;
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['patch']);
    expect(tool.inputSchema.required).toEqual(['patch']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  it('does not let a retired cwd field silently rebase relative patch paths', async () => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ create: true });
    await fs.mkdir(path.join(mcpHarness.approved, 'nested'), { recursive: true });
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('../escaped.txt', ['x']), cwd: '/workspace/nested' }
    });
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(mcpHarness.approved, 'escaped.txt'))).rejects.toThrow();
  });

  it('still applies an ordinary relative patch path against its base', async () => {
    // The refusals above must not have been bought by breaking shorthand itself.
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ create: true });
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('relative-landed.txt', ['x']) }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(mcpHarness.approved, 'relative-landed.txt'), 'utf8')).toContain('x');
  });

  it('never reveals a real Windows path', async () => {
    const reply = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace'] } });
    const text = textOf(reply);
    expect(text).toContain('/workspace');
    expect(text).not.toContain(mcpHarness.approved);
  });

  it('tells the model the approved roots and the current mode without spending a tool call', async () => {
    // list_roots is gone: the roots are one line of server instructions now, because a round trip every conversation paid before it could do anything was pure overhead.
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    const instructions: string = reply.body.result.instructions ?? '';
    expect(instructions).toContain('/workspace');
    expect(instructions).toContain('local tools are read-only');
  });

  /** Every worked example the model is shown must name a root that exists, and no error may send it after a tool that does not. Both cost a refused call and a retry, and neither is visible from inside the app. */
  it('names only live roots and live tools in what the model is shown', async () => {
    const read = toolList(await core('tools/list')).find((tool) => tool.name === 'read')!;
    const paths = String(read.inputSchema.properties.paths.description);
    expect(paths).toContain('/workspace');
    // `/project` is nobody's root; it was a hardcoded example the model could not act on.
    expect(paths).not.toContain('/project');

    // Nor may anything be invented *after* the root. `/workspace/src/main.ts` named a live root and was still a worked example the model could not act on, and a worse one than `/project`: a project-shaped suffix reads as a promise that the root is the project. An approved root is routinely a parent holding several, and reading it the other way is what produced `/<root>/AGENTS.md` for a file one folder deeper — the most repeated read failure in the recorded corpus. What replaces it is the relationship, not another path, so there is nothing left here that can go stale.
    expect(paths).not.toMatch(/\/workspace\/\S+\.\w+/);
    expect(paths).toContain('parent of the project');
    expect(paths).toContain('workdir');

    // list_roots is retired, so no refusal may tell the model to call it. A native path outside every root is the refusal that used to, and it must still name the roots that do exist.
    const refusal = textOf(
      await core('tools/call', { name: 'read', arguments: { paths: [path.join(os.tmpdir(), 'nope.txt')] } })
    );
    expect(refusal).toContain('Approved roots');
    expect(refusal).not.toContain('list_roots');
  });
});
