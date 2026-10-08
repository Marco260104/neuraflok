import {
  core,
  failed,
  fs,
  modern,
  observeRequestCorrelation,
  path,
  setWorkspaceFor,
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

describe('bounded output', () => {
  it('expands a leading relative glob inside the proven chat workspace', async () => {
    const requestId = 'wfr_relative_glob';
    const conversationId = 'conv-relative-glob';
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId,
        sessionId: 'session-relative-glob',
        messageId: 'message-relative-glob',
        tool: 'read',
        observedAt: Date.now()
      })
    ).toBe('stored');
    setWorkspaceFor(`chat:${conversationId}`, {
      virtual: '/workspace/src',
      real: path.join(mcpHarness.approved, 'src')
    });

    const reply = await modern(
      'tools/call',
      { name: 'read', arguments: { paths: ['**/*.ts'], start_line: 1, end_line: 1 } },
      { 'x-request-id': `${requestId}/att1` }
    );
    expect(failed(reply)).toBe(false);
    expect(textOf(reply)).toContain('/workspace/src/app.ts');
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
  });

  it('returns only the requested line range', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'], start_line: 3, end_line: 5 }
    });
    const text = textOf(reply);
    expect(text).toContain('note line 3');
    expect(text).toContain('note line 5');
    expect(text).not.toContain('note line 6');
    expect(text).toContain('lines 3-5');
    // The total is unknown after a ranged read, so the model gets a resume point instead of a misleading "of ?".
    expect(text).not.toContain('of ?');
    expect(text).toContain('continue from line 6');
  });

  it('honours a line range across every file it read, and says that it did', async () => {
    // The advertised contract has to match the runtime one, or the model learns the rule from a failed call instead of from the tool list.
    const readTool = toolList(await core('tools/list')).find((tool) => tool.name === 'read')!;
    expect(String(readTool.description)).toMatch(/apply to every file the call resolves to/i);
    expect(String(readTool.description)).toContain('path:12-40');
    expect(String(readTool.inputSchema.properties.start_line.description)).toMatch(/every file/i);
    expect(String(readTool.inputSchema.properties.end_line.description)).toMatch(/every file/i);

    // Refusing this was the single largest source of rejected calls in the recorded sessions, and every one of them was a caller that had already said what it wanted. The original objection was to dropping the range *silently* — so it is applied and announced. What must never come back is a reply that looks like a whole-file read.
    const many = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt', '/workspace/src/app.ts'], start_line: 10, end_line: 12 }
    });
    expect(failed(many)).toBe(false);
    const text = textOf(many);
    expect(text).toContain('note line 10');
    expect(text).toContain('note line 12');
    expect(text).not.toContain('note line 9');
    expect(text).not.toContain('note line 13');
    // Announced in the body, and restated by the header of every section.
    expect(text).toMatch(/applied to each of the 2 files/i);
    expect(text).toMatch(/\/workspace\/notes\.txt — lines 10-12/);
    // The property the original refusal existed to protect: a file with nothing in that range says so outright, so a short file can never read as a complete one.
    expect(text).toMatch(/\/workspace\/src\/app\.ts — no lines in that range/);

    // A glob is the usual way one path turns into several, so it must behave identically.
    const glob = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/**/*.ts'], start_line: 1, end_line: 1 }
    });
    expect(failed(glob)).toBe(false);
    expect(textOf(glob)).toMatch(/lines 1-1/);

    // One path is still one path: nothing is announced when there was nothing to spread.
    const single = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'], start_line: 10, end_line: 12 }
    });
    expect(textOf(single)).not.toMatch(/applied to each/i);
    expect(textOf(single)).toContain('note line 10');
  });

  it('reports the total when the whole file was read', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('lines 1-1 of 1');
    expect(text).not.toContain('continue from line');
  });

  it('returns a whole small file when it fits inside the default read budget', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'] }
    });
    const text = textOf(reply);
    expect(text).toContain('lines 1-50 of 50');
    expect(text).toContain('note line 1');
    expect(text).toContain('note line 50');
    expect(text).not.toContain('truncated');
    expect(text).not.toContain('continue from line');
  });

  it('reads a typical 1,500-line source file whole by default and tells the model not to pre-paginate', async () => {
    const lines = Array.from({ length: 1_500 }, (_, index) =>
      `${String(index + 1).padStart(4, '0')} export const measuredDefaultReadLine = '${'x'.repeat(64)}';`
    );
    await fs.writeFile(path.join(mcpHarness.approved, 'long-default-read.ts'), `${lines.join('\n')}\n`, 'utf8');

    const readTool = toolList(await core('tools/list')).find((tool) => tool.name === 'read')!;
    expect(String(readTool.description)).toMatch(/1,500-line source file/i);
    expect(String(readTool.description)).toMatch(/do not pre-paginate/i);

    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/long-default-read.ts'] }
    });
    const text = textOf(reply);
    expect(failed(reply), text).toBe(false);
    expect(text).toContain('lines 1-1500 of 1500');
    expect(text).toContain('1500 export const measuredDefaultReadLine');
    expect(text).not.toContain('continue from line');
  });

  /* The line count is the header's answer to "how long is this file", and a range is exactly when that matters: 3 lines with no denominator cannot be told apart from a whole file. The read counts on past the range to fill it in. */
  it('states the file total on a ranged read, so a slice cannot read as the whole file', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'], start_line: 3, end_line: 5 }
    });
    const text = textOf(reply);
    expect(text).toContain('lines 3-5 of 50');
    expect(text).toContain('more lines follow — continue from line 6');
  });

  it('lists a folder one level deep, marking what each entry is', async () => {
    // A folder read is one level and nothing more. Dependency folders are shown here — hiding a directory the user can see in Explorer would be a lie — but nothing descends into them, which is where the cost would actually have been.
    const reply = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace'] } });
    const text = textOf(reply);
    expect(text).toContain('one level');
    expect(text).toContain('d src');
    expect(text).toContain('f notes.txt');
    expect(text).not.toContain('noise.js');
    expect(text).not.toContain('app.ts');
  });

  it('lists the shared folders for the virtual root, where a model naturally starts', async () => {
    // Live on macOS (2026-10-04): "read /" answered only "Path is empty. Use an approved virtual root such as /<root>/file.txt.", so the model had to guess the folder names.
    const reply = await core('tools/call', { name: 'read', arguments: { paths: ['/', '/workspace/notes.txt'] } });
    const text = textOf(reply);
    expect(failed(reply), text).toBe(false);
    expect(text).toContain('--- / — 1 entry, one level ---');
    expect(text).toContain('d workspace');
    expect(text).not.toContain('ERROR');
    expect(text).not.toContain(mcpHarness.approved);
  });

  it('validates tool arguments instead of trusting them', async () => {
    const reply = await core('tools/call', { name: 'read', arguments: { paths: [12345] } });
    expect(failed(reply)).toBe(true);
  });

  it('honours max_bytes instead of rejecting or silently ignoring the advertised read budget', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'], max_bytes: 60 }
    });
    expect(failed(reply)).toBe(false);
    expect(textOf(reply)).toContain('continue from line');
    expect(textOf(reply)).not.toContain('note line 50');
  });

  it('rejects a whitespace-only find query instead of walking the workspace for everything', async () => {
    mcpHarness.ctx.caps = withCaps({ search: true });
    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: '   ', mode: 'content' }
    });
    expect(failed(reply)).toBe(true);
  });

  it('fails an exact oversized content search instead of recording an unsearched file as a successful no-match', async () => {
    mcpHarness.ctx.caps = withCaps({ search: true });
    const oversized = path.join(mcpHarness.approved, 'oversized-search.log');
    const handle = await fs.open(oversized, 'w');
    try {
      await handle.truncate(2 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    try {
      const reply = await core('tools/call', {
        name: 'find',
        arguments: { query: 'needle', mode: 'content', path: '/workspace/oversized-search.log' }
      });
      expect(failed(reply)).toBe(true);
      expect(textOf(reply)).toContain('File was not searched');
      expect(textOf(reply)).not.toContain('No matches');
    } finally {
      await fs.rm(oversized, { force: true });
    }
  });

  it('rejects find options that the selected mode would silently ignore', async () => {
    mcpHarness.ctx.caps = withCaps({ search: true });
    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: 'notes', mode: 'name', regex: true }
    });
    expect(failed(reply)).toBe(true);
  });

  it('reports a missing file plainly without losing the reads that worked', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts', '/workspace/nope.txt', '/workspace/src/lib/util.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('export const name = "app";');
    expect(text).toContain('/workspace/nope.txt — ERROR');
    expect(text).toMatch(/Not found/i);
    expect(text).toContain('export const helper = 1;');
  });

  it('lists the nearest folder that does exist under a missing path', async () => {
    // A file guessed one folder too high was the most repeated read failure in the recorded sessions, and every one of them was followed by a listing call. The listing now rides along with the refusal, from the deepest ancestor that resolved.
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/lib/nested/util.ts'] }
    });
    const text = textOf(reply);
    expect(failed(reply)).toBe(true);
    expect(text).toMatch(/Not found/i);
    expect(text).toContain('The nearest existing folder is /workspace/src/lib; it contains: f util.ts');
    const top = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/lib/util.ts'] } });
    expect(textOf(top)).toMatch(/The nearest existing folder is \/workspace; it contains: .*d src, .*f notes\.txt/);
  });

  it('reads a per-path line range spelled as path:start-end', async () => {
    // Four reads in the recorded sessions asked for several ranges of one file this way and were refused for the colon; the spelling is now the range it was meant to be, and a path without one keeps the call-wide start_line/end_line.
    const reply = await core('tools/call', {
      name: 'read',
      arguments: {
        paths: ['/workspace/notes.txt:3-4', '/workspace/notes.txt:48', '/workspace/src/app.ts'],
        start_line: 1,
        end_line: 1
      }
    });
    const text = textOf(reply);
    expect(failed(reply), text).toBe(false);
    expect(text).toContain('lines 3-4');
    expect(text).toContain('note line 3');
    expect(text).toContain('note line 4');
    expect(text).not.toMatch(/^5	note line 5$/m);
    expect(text).toContain('note line 48');
    expect(text).toContain('note line 50');
    expect(text).not.toContain('note line 47');
    expect(text).toContain('export const name = "app";');
    expect(text).not.toContain('applied to each of');
    const backwards = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/notes.txt:9-3'] } });
    expect(failed(backwards)).toBe(true);
  });

  it('fails when every explicit read target failed, while keeping partial multi-read useful', async () => {
    const allMissing = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/nope-a.txt', '/workspace/nope-b.txt'] }
    });
    expect(failed(allMissing)).toBe(true);
    expect(textOf(allMissing)).toContain('/workspace/nope-a.txt — ERROR');
    expect(textOf(allMissing)).toContain('/workspace/nope-b.txt — ERROR');

    const partial = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts', '/workspace/nope.txt'] }
    });
    expect(failed(partial)).toBe(false);
    expect(textOf(partial)).toContain('export const name = "app";');
    expect(textOf(partial)).toContain('/workspace/nope.txt — ERROR');
  });

  it('reads several files in one call', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts', '/workspace/src/lib/util.ts'] }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('export const name = "app";');
    expect(textOf(reply)).toContain('export const helper = 1;');
  });

  it('bounds line-number expansion inside the advertised read payload budget', async () => {
    const target = path.join(mcpHarness.approved, 'many-empty-lines.txt');
    await fs.writeFile(target, '\n'.repeat(90_000));
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/many-empty-lines.txt'], max_bytes: 64 * 1024 }
    });
    const text = textOf(reply);
    expect(failed(reply)).toBe(false);
    // Raw bytes are cheap here; decimal line-number prefixes are not. The old path enforced max_bytes before numbering and could turn a 64 KiB slice into hundreds of KiB on the wire.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(72 * 1024);
    expect(text).toContain('output cap reached');
  });

  it('renders an empty logical line instead of mistaking it for no line in the range', async () => {
    await fs.writeFile(path.join(mcpHarness.approved, 'leading-empty-line.txt'), '\nsecond\n');
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/leading-empty-line.txt'], start_line: 1, end_line: 1 }
    });
    const text = textOf(reply);
    expect(failed(reply)).toBe(false);
    expect(text).toMatch(/\n1\t(?:\n|$)/);
    expect(text).toContain('lines 1-1 of 2');
  });

  it('reports an exhausted glob scan instead of claiming there were no matches', async () => {
    const broad = path.join(mcpHarness.approved, 'glob-scan-cap');
    await fs.mkdir(broad, { recursive: true });
    try {
      // `walkFiles` is capped at 5,000 examined entries. Put the only matching file after that boundary lexically so the old adapter dropped walk.truncated and lied with "no matches".
      for (let start = 0; start < 5_000; start += 200) {
        await Promise.all(
          Array.from({ length: Math.min(200, 5_000 - start) }, (_, offset) =>
            fs.writeFile(path.join(broad, `${String(start + offset).padStart(5, '0')}.txt`), '')
          )
        );
      }
      await fs.writeFile(path.join(broad, 'zzzzz.needle.ts'), 'export const needle = true;\n');

      const reply = await core('tools/call', {
        name: 'read',
        arguments: { paths: ['/workspace/glob-scan-cap/**/*.needle.ts'] }
      });
      const text = textOf(reply);
      expect(failed(reply)).toBe(false);
      expect(text).toContain('glob scan stopped after 5000 entries');
      expect(text).not.toContain(': no matches');
    } finally {
      await fs.rm(broad, { recursive: true, force: true });
    }
  });

  it('does not call an exactly-full glob result truncated until a 21st match actually exists', async () => {
    const folder = path.join(mcpHarness.approved, 'exact-glob-cap');
    await fs.mkdir(folder, { recursive: true });
    for (let index = 0; index < 20; index++) {
      await fs.writeFile(path.join(folder, `match-${String(index).padStart(2, '0')}.ts`), `export const n = ${index};\n`);
    }

    const exact = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/exact-glob-cap/*.ts'] }
    });
    expect(failed(exact)).toBe(false);
    expect(textOf(exact)).not.toContain('more than 20 matches');

    await fs.writeFile(path.join(folder, 'match-20.ts'), 'export const n = 20;\n');
    const overflow = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/exact-glob-cap/*.ts'] }
    });
    expect(failed(overflow)).toBe(false);
    expect(textOf(overflow)).toContain('more than 20 matches');
  });

  it('expands a glob rather than making the model list the files itself', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/**/*.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('export const name = "app";');
    expect(text).toContain('export const helper = 1;');
  });

  it('says so when a glob matches nothing instead of failing the call', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/**/*.nothing'] }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('no matches');
  });
});
