import {
  IS_WINDOWS,
  addPatch,
  core,
  fs,
  path,
  randomBytes,
  sharp,
  textOf,
  withCaps,
} from './context.js';
import { mcpHarness } from './context.js';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

describe('apply_patch', () => {
  beforeEach(() => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ create: true, edit: true, move: true, deleteFile: true });
  });

  it.each([true, false])('returns mismatch guidance with source excerpts only under Read permission (%s)', async read => {
    mcpHarness.ctx.caps = withCaps({ read, edit: true });
    const original = 'uniqueAnchor();\nactualSourceOnly();\n';
    await fs.writeFile(path.join(mcpHarness.approved, 'diagnostic.txt'), original);
    await fs.writeFile(path.join(mcpHarness.approved, 'unchanged.txt'), 'before\n');
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: [
        '*** Begin Patch', '*** Update File: /workspace/unchanged.txt', '@@', '-before', '+after',
        '*** Update File: /workspace/diagnostic.txt', '@@', ' uniqueAnchor();', '-guessedSource();', '+replacement();',
        '*** End Patch'
      ].join('\n') }
    });
    expect(reply.body.result?.isError).toBe(true);
    const text = textOf(reply);
    expect(text).toContain('Use the current file text as patch context');
    expect(text).toContain('/workspace/diagnostic.txt');
    expect(text).not.toContain(mcpHarness.approved);
    expect(text.includes('actualSourceOnly();')).toBe(read);
    expect(text.includes('Source excerpt from the patch verification snapshot')).toBe(read);
    expect(await fs.readFile(path.join(mcpHarness.approved, 'diagnostic.txt'), 'utf8')).toBe(original);
    expect(await fs.readFile(path.join(mcpHarness.approved, 'unchanged.txt'), 'utf8')).toBe('before\n');
  });

  it('resolves later hunks against files created earlier in the same patch', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Add File: /workspace/fresh-sequential.ts',
          '+const fresh = 1;',
          '*** Update File: /workspace/fresh-sequential.ts',
          '@@',
          '-const fresh = 1;',
          '+const fresh = 2;',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(path.join(mcpHarness.approved, 'fresh-sequential.ts'), 'utf8')).toBe('const fresh = 2;\n');
  });

  it('adds, updates, moves and deletes through one tool', async () => {
    const added = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/scratch.txt', ['first', 'second']) }
    });
    expect(added.body.result?.isError).toBeFalsy();
    expect(textOf(added)).toContain('A /workspace/scratch.txt');

    const edited = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: ['*** Begin Patch', '*** Update File: /workspace/scratch.txt', '@@', '-second', '+SECOND', '*** End Patch'].join('\n')
      }
    });
    expect(edited.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(mcpHarness.approved, 'scratch.txt'), 'utf8')).toContain('SECOND');

    const moved = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/scratch.txt',
          '*** Move to: /workspace/moved.txt',
          '@@',
          ' SECOND',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(moved.body.result?.isError).toBeFalsy();
    await expect(fs.stat(path.join(mcpHarness.approved, 'scratch.txt'))).rejects.toThrow();

    const deleted = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: ['*** Begin Patch', '*** Delete File: /workspace/moved.txt', '*** End Patch'].join('\n') }
    });
    expect(deleted.body.result?.isError).toBeFalsy();
    await expect(fs.stat(path.join(mcpHarness.approved, 'moved.txt'))).rejects.toThrow();
  });

  // Empty update hunks are invalid, so a pure rename carries one context-only line.
  it('renames without Edit, and still refuses to rewrite content', async () => {
    const source = path.join(mcpHarness.approved, 'rename-me.txt');
    const occupied = path.join(mcpHarness.approved, 'rename-occupied.txt');
    // A move-only permission must preserve bytes and must not normalize line endings.
    await fs.writeFile(source, 'keep this\r\n', 'utf8');
    await fs.writeFile(occupied, `do not replace${String.fromCharCode(10)}`, 'utf8');
    mcpHarness.ctx.caps = withCaps({ move: true, edit: false });

    const overwrite = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/rename-me.txt',
          '*** Move to: /workspace/rename-occupied.txt',
          '@@',
          ' keep this',
          '*** End Patch'
        ].join(String.fromCharCode(10))
      }
    });
    expect(overwrite.body.result?.isError).toBe(true);
    expect(textOf(overwrite)).toContain('Edit files is disabled');
    expect(await fs.readFile(source, 'utf8')).toContain('keep this');
    expect(await fs.readFile(occupied, 'utf8')).toContain('do not replace');

    const moved = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/rename-me.txt',
          '*** Move to: /workspace/renamed.txt',
          '@@',
          ' keep this',
          '*** End Patch'
        ].join(String.fromCharCode(10))
      }
    });
    expect(moved.body.result?.isError, textOf(moved)).toBeFalsy();
    expect(await fs.readFile(path.join(mcpHarness.approved, 'renamed.txt'), 'utf8')).toBe('keep this\r\n');

    const rewritten = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/renamed.txt',
          '*** Move to: /workspace/renamed-again.txt',
          '@@',
          '-keep this',
          '+changed',
          '*** End Patch'
        ].join(String.fromCharCode(10))
      }
    });
    expect(rewritten.body.result?.isError).toBe(true);
    expect(textOf(rewritten)).toContain('TOOL_DISABLED');
    expect(await fs.readFile(path.join(mcpHarness.approved, 'renamed.txt'), 'utf8')).toBe('keep this\r\n');
  });

  it('rejects an empty move-only update hunk', async () => {
    const source = path.join(mcpHarness.approved, 'empty-move-source.txt');
    const target = path.join(mcpHarness.approved, 'empty-move-target.txt');
    await fs.writeFile(source, 'keep this\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/empty-move-source.txt',
          '*** Move to: /workspace/empty-move-target.txt',
          '*** End Patch'
        ].join('\n')
      }
    });

    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain("Update file hunk for path '/workspace/empty-move-source.txt' is empty");
    expect(await fs.readFile(source, 'utf8')).toBe('keep this\n');
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it('changes several files in one atomic patch', async () => {
    const a = path.join(mcpHarness.approved, 'batch-a.txt');
    const b = path.join(mcpHarness.approved, 'batch-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/batch-a.txt',
          '@@',
          '-alpha',
          '+ALPHA',
          '*** Update File: /workspace/batch-b.txt',
          '@@',
          '-beta',
          '+BETA',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('Success. Updated the following files:');
    expect(textOf(reply)).toContain('M /workspace/batch-a.txt');
    expect(textOf(reply)).toContain('M /workspace/batch-b.txt');
    expect(await fs.readFile(a, 'utf8')).toBe('ALPHA\n');
    expect(await fs.readFile(b, 'utf8')).toBe('BETA\n');
  });

  it.runIf(IS_WINDOWS)('rolls back earlier files when a later commit fails after verification', async () => {
    const a = path.join(mcpHarness.approved, 'batch-runtime-fail-a.txt');
    const b = path.join(mcpHarness.approved, 'batch-runtime-fail-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');
    // Read-only permits verification but fails the second runtime write after the first file commits.
    await fs.chmod(b, 0o444);
    try {
      const reply = await core('tools/call', {
        name: 'apply_patch',
        arguments: {
          patch: [
            '*** Begin Patch',
            '*** Update File: /workspace/batch-runtime-fail-a.txt',
            '@@',
            '-alpha',
            '+ALPHA',
            '*** Update File: /workspace/batch-runtime-fail-b.txt',
            '@@',
            '-beta',
            '+BETA',
            '*** End Patch'
          ].join('\n')
        }
      });
      expect(reply.body.result?.isError).toBe(true);
      expect(textOf(reply)).toContain('rolled back');
      expect(await fs.readFile(a, 'utf8')).toBe('alpha\n');
      expect(await fs.readFile(b, 'utf8')).toBe('beta\n');
    } finally {
      await fs.chmod(b, 0o666).catch(() => undefined);
    }
  });

  it('leaves every target untouched when one hunk in the patch does not apply', async () => {
    const a = path.join(mcpHarness.approved, 'batch-fail-a.txt');
    const b = path.join(mcpHarness.approved, 'batch-fail-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/batch-fail-a.txt',
          '@@',
          '-alpha',
          '+ALPHA',
          '*** Update File: /workspace/batch-fail-b.txt',
          '@@',
          '-missing',
          '+BETA',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(await fs.readFile(a, 'utf8')).toBe('alpha\n');
    expect(await fs.readFile(b, 'utf8')).toBe('beta\n');
  });

  it('applies Add File semantics and overwrites an existing file', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/notes.txt', ['clobbered']) }
    });
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(path.join(mcpHarness.approved, 'notes.txt'), 'utf8')).toBe('clobbered\n');
  });

  it('names the problem when the patch itself is malformed', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: 'just some text' }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain("invalid patch: The first line of the patch must be '*** Begin Patch'");
  });

  it('rejects hidden environment selection in the single-environment adapter', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Environment ID: other',
      '*** Add File: env-selected.txt',
      '+should-not-land',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch } });
    expect(reply.body.result?.isError).toBe(true);
    expect(reply.body.result.content[0]).toEqual({ type: 'text', text: 'apply_patch environment selection is unavailable for this turn' });
    await expect(fs.stat(path.join(mcpHarness.approved, 'env-selected.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the patch result shape for a huge rewrite', async () => {
    const before = Array.from({ length: 1600 }, (_, index) => `old-${index}`);
    await fs.writeFile(path.join(mcpHarness.approved, 'rewrite.txt'), `${before.join('\n')}\n`, 'utf8');
    const hunk = [
      '*** Begin Patch',
      '*** Update File: /workspace/rewrite.txt',
      '@@',
      ...before.map((line) => `-${line}`),
      ...before.map((_, index) => `+new-${index}`),
      '*** End Patch'
    ].join('\n');

    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch: hunk } });
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(textOf(reply)).toContain('Exit code: 0');
    expect(textOf(reply)).toContain('Success. Updated the following files:');
    expect(textOf(reply)).toContain('M /workspace/rewrite.txt');
    expect(textOf(reply)).not.toContain('(~+');
  });

  it('returns a small image without applying the text-section byte default', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/pixel.png'] }
    });
    expect(textOf(reply)).not.toContain('image is too large to return');
    const content = reply.body.result?.content as Array<Record<string, unknown>>;
    expect(content.some((item) => item.type === 'image')).toBe(true);
  });

  it('uses a separate bounded image budget so ordinary screenshots work through read', async () => {
    const target = path.join(mcpHarness.approved, 'large-noise.png');
    await sharp(randomBytes(512 * 512 * 4), { raw: { width: 512, height: 512, channels: 4 } })
      .png({ compressionLevel: 0 })
      .toFile(target);

    const readReply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/large-noise.png'] }
    });
    expect(readReply.body.result?.isError, textOf(readReply)).not.toBe(true);

    const imageReply = await core('tools/call', {
      name: 'view_image',
      arguments: { path: '/workspace/large-noise.png' }
    });
    expect(imageReply.body.result?.isError, textOf(imageReply)).not.toBe(true);
    expect((imageReply.body.result?.content as Array<{ type: string }>).some((item) => item.type === 'image')).toBe(true);
    expect(readReply.body.result?.content.filter((item: any) => item.type === 'image'))
      .toEqual(imageReply.body.result?.content.filter((item: any) => item.type === 'image'));

    const batch = await core('tools/call', { name: 'read', arguments: {
      paths: [...Array(5).fill('/workspace/large-noise.png'), '/workspace/pixel.png']
    } });
    expect(batch.body.result?.content.filter((item: any) => item.type === 'image')).toHaveLength(4);
    expect(textOf(batch)).toContain('image output cap');

    await sharp(randomBytes(1500 * 1000 * 4), { raw: { width: 1500, height: 1000, channels: 4 } })
      .png({ compressionLevel: 0 }).toFile(path.join(mcpHarness.approved, 'image-budget.png'));
    const bytes = await core('tools/call', { name: 'read', arguments: {
      paths: ['/workspace/image-budget.png', '/workspace/image-budget.png', '/workspace/pixel.png']
    } });
    const emitted = bytes.body.result?.content.filter((item: any) => item.type === 'image');
    expect(emitted).toHaveLength(2); // The refused large second file cannot suppress a later fitting image.
    expect(emitted.reduce((n: number, item: any) => n + item.data.length, 0)).toBeLessThanOrEqual(12 * 1024 * 1024);
    expect(textOf(bytes)).toContain('image output cap');
  });

  it('accepts a native filesystem path inside apply_patch', async () => {
    const target = path.join(mcpHarness.approved, 'native-patch.txt');
    const patch = [
      '*** Begin Patch',
      `*** Add File: ${target}`,
      '+native-patch-ok',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch } });
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(target, 'utf8')).toBe('native-patch-ok\n');
    expect(textOf(reply)).toContain('A /workspace/native-patch.txt');
    expect(textOf(reply)).not.toContain(mcpHarness.approved);
  });

  it('normalizes native filesystem update, move and delete paths inside apply_patch', async () => {
    const source = path.join(mcpHarness.approved, 'native-patch-source.txt');
    const moved = path.join(mcpHarness.approved, 'native-patch-moved.txt');
    await fs.writeFile(source, 'before\n', 'utf8');

    const movePatch = [
      '*** Begin Patch',
      `*** Update File: ${source}`,
      `*** Move to: ${moved}`,
      '@@',
      '-before',
      '+after',
      '*** End Patch'
    ].join('\n');
    const movedReply = await core('tools/call', { name: 'apply_patch', arguments: { patch: movePatch } });
    expect(movedReply.body.result?.isError, textOf(movedReply)).toBeFalsy();
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(moved, 'utf8')).toBe('after\n');
    expect(textOf(movedReply)).toContain('/workspace/native-patch-moved.txt');
    expect(textOf(movedReply)).not.toContain(mcpHarness.approved);

    const deletePatch = ['*** Begin Patch', `*** Delete File: ${moved}`, '*** End Patch'].join('\n');
    const deletedReply = await core('tools/call', { name: 'apply_patch', arguments: { patch: deletePatch } });
    expect(deletedReply.body.result?.isError, textOf(deletedReply)).toBeFalsy();
    await expect(fs.stat(moved)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(textOf(deletedReply)).toContain('D /workspace/native-patch-moved.txt');
    expect(textOf(deletedReply)).not.toContain(mcpHarness.approved);
  });

  it('does not leak the resolved real path when apply_patch fails after validation', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: /workspace/notes.txt/child.txt',
      '+cannot-land-under-a-file',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch } });
    expect(reply.body.result?.isError).toBe(true);
    // The host errno text differs here: Windows can retain the safe virtual spelling while POSIX reports ENOTDIR without a path. The invariant is that neither form leaks `approved`.
    expect(textOf(reply)).toMatch(/\/workspace\/notes\.txt\/child\.txt|Filesystem error \(ENOTDIR\)/);
    expect(textOf(reply)).not.toContain(mcpHarness.approved);
  });
});
