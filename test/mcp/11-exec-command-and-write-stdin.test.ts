import {
  IS_WINDOWS,
  core,
  execHints,
  failed,
  fs,
  getConfig,
  locateRipgrep,
  path,
  textOf,
  toolList,
  unifiedExecManager,
  withCaps,
} from './context.js';
import { mcpHarness } from './context.js';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

describe('exec_command and write_stdin', () => {
  beforeEach(() => {
    mcpHarness.ctx.readOnly = false;
    mcpHarness.ctx.caps = withCaps({ command: true });
    getConfig().commandAllowlist = { enabled: false, mode: 'allow', rules: [] };
  });

  it('enforces the same optional policy at the shared handler before process launch', async () => {
    const command = IS_WINDOWS ? 'Write-Output allowlist-ok' : "printf '%s\\n' allowlist-ok";
    getConfig().commandAllowlist = { enabled: true, mode: 'allow', rules: [command] };
    const allowed = await core('tools/call', {
      name: 'exec_command', arguments: { cmd: command, workdir: '/workspace', yield_time_ms: 5_000 }
    });
    expect(failed(allowed), textOf(allowed)).toBe(false);
    expect(textOf(allowed)).toContain('allowlist-ok');

    const launch = vi.spyOn(unifiedExecManager, 'execCommand');
    const denied = await core('tools/call', {
      name: 'exec_command', arguments: { cmd: IS_WINDOWS ? 'Write-Output denied' : 'printf denied', workdir: '/workspace' }
    });
    expect(failed(denied)).toBe(true);
    expect(textOf(denied)).toContain('COMMAND_NOT_ALLOWED');
    expect(textOf(denied)).toContain('No command was run');
    expect(launch).not.toHaveBeenCalled();
    launch.mockRestore();
  });

  it('preflights a complete batch before launching its allowed first command', async () => {
    getConfig().commandAllowlist = { enabled: true, mode: 'allow', rules: ['git status'] };
    const launch = vi.spyOn(unifiedExecManager, 'execCommand');
    const denied = await core('tools/call', {
      name: 'exec_command', arguments: { cmds: ['git status', 'git diff'], workdir: '/workspace' }
    });
    expect(failed(denied)).toBe(true);
    expect(textOf(denied)).toContain('in command 2');
    expect(launch).not.toHaveBeenCalled();
    launch.mockRestore();
  });

  it('preflights a complete denylist batch before launching its allowed first command', async () => {
    getConfig().commandAllowlist = { enabled: true, mode: 'deny', rules: ['git diff *'] };
    const launch = vi.spyOn(unifiedExecManager, 'execCommand');
    const denied = await core('tools/call', {
      name: 'exec_command', arguments: { cmds: ['git status', 'git diff --stat'], workdir: '/workspace' }
    });
    expect(failed(denied)).toBe(true);
    expect(textOf(denied)).toContain('in command 2');
    expect(textOf(denied)).toContain('matched a deny rule');
    expect(launch).not.toHaveBeenCalled();
    launch.mockRestore();
  });

  it.runIf(IS_WINDOWS)('rejects normalization argument drift before launch in both policy modes', async () => {
    const raw = 'Write-Output parity';
    const normalize = vi.spyOn(execHints, 'normalizeShellCommand').mockReturnValue({
      cmd: 'Write-Output parity changed',
      notes: []
    });
    const launch = vi.spyOn(unifiedExecManager, 'execCommand');
    try {
      for (const commandAllowlist of [
        { enabled: true, mode: 'allow' as const, rules: [raw] },
        { enabled: true, mode: 'deny' as const, rules: ['git status'] }
      ]) {
        getConfig().commandAllowlist = commandAllowlist;
        const denied = await core('tools/call', {
          name: 'exec_command', arguments: { cmd: raw, workdir: '/workspace' }
        });
        expect(failed(denied)).toBe(true);
        expect(textOf(denied)).toContain('command normalization changed the authorized argument list');
      }
      expect(launch).not.toHaveBeenCalled();
    } finally {
      normalize.mockRestore();
      launch.mockRestore();
    }
  });

  it('checks policy before intercepted apply_patch can mutate a file', async () => {
    getConfig().commandAllowlist = { enabled: true, mode: 'allow', rules: ['git status'] };
    const target = path.join(mcpHarness.approved, 'allowlist-intercept.txt');
    const patch = ['*** Begin Patch', '*** Add File: allowlist-intercept.txt', '+must-not-land', '*** End Patch'].join('\n');
    const denied = await core('tools/call', {
      name: 'exec_command', arguments: { cmd: `apply_patch <<'PATCH'\n${patch}\nPATCH`, workdir: '/workspace' }
    });
    expect(failed(denied)).toBe(true);
    expect(textOf(denied)).toContain('COMMAND_NOT_ALLOWED');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an approved virtual path in opaque shell text instead of running against the drive root', async () => {
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: { cmd: 'type /workspace/notes.txt', workdir: '/workspace' }
    });

    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('INVALID_COMMAND_PATH');
    expect(textOf(reply)).toContain('/workspace/notes.txt');
    expect(textOf(reply)).toMatch(/relative path|native filesystem path/i);
    expect(textOf(reply)).toContain('No command was run');
  });

  it('intercepts explicit apply_patch shell invocations through the patch runtime', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: intercepted.txt',
      '+intercepted-ok',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: `apply_patch <<'PATCH'\n${patch}\nPATCH`,
        workdir: '/workspace'
      }
    });

    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(textOf(reply)).toContain('Wall time: 0.0000 seconds');
    expect(textOf(reply)).toContain('Exit code: 0');
    expect(textOf(reply)).toContain('A intercepted.txt');
    expect(await fs.readFile(path.join(mcpHarness.approved, 'intercepted.txt'), 'utf8')).toBe('intercepted-ok\n');
    expect(reply.body.result?.structuredContent).toMatchObject({
      wall_time_seconds: 0,
      output: expect.stringContaining('Success. Updated the following files:')
    });
    expect(reply.body.result?.structuredContent).not.toHaveProperty('exit_code');
    expect(reply.body.result?.structuredContent).not.toHaveProperty('session_id');
  });

  it('applies intercepted cd workdir exactly once', async () => {
    await fs.mkdir(path.join(mcpHarness.approved, 'nested'), { recursive: true });
    const patch = [
      '*** Begin Patch',
      '*** Add File: from-cd.txt',
      '+nested-ok',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: `cd nested && apply_patch <<'PATCH'\n${patch}\nPATCH`,
        workdir: '/workspace'
      }
    });

    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(path.join(mcpHarness.approved, 'nested', 'from-cd.txt'), 'utf8')).toBe('nested-ok\n');
    await expect(fs.stat(path.join(mcpHarness.approved, 'nested', 'nested', 'from-cd.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a raw patch body passed as a command', async () => {
    const patch = ['*** Begin Patch', '*** Add File: implicit.txt', '+nope', '*** End Patch'].join('\n');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: { cmd: patch, workdir: '/workspace' }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(reply.body.result.content[0]).toEqual({ type: 'text', text:
      'apply_patch verification failed: patch detected without explicit call to apply_patch. Rerun as ["apply_patch", "<patch>"]'
    });
    await expect(fs.stat(path.join(mcpHarness.approved, 'implicit.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not intercept through a missing cd target that the shell would have rejected', async () => {
    const missing = path.join(mcpHarness.approved, 'missing-intercept-cwd');
    const patch = [
      '*** Begin Patch',
      '*** Add File: landed.txt',
      '+must-not-land',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: `cd missing-intercept-cwd && apply_patch <<'PATCH'\n${patch}\nPATCH`,
        workdir: '/workspace'
      }
    });

    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toMatch(/not found/i);
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a native filesystem workdir inside an approved root', async () => {
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: IS_WINDOWS ? 'Write-Output native-workdir-ok' : "printf '%s\\n' native-workdir-ok",
        workdir: mcpHarness.approved,
        yield_time_ms: 5_000
      }
    });
    expect(reply.body.result?.isError).not.toBe(true);
    expect(textOf(reply)).toContain('native-workdir-ok');
  });

  it('uses the shared scrubbed child environment and exposes bundled ripgrep', async () => {
    // Unified exec used to construct a second, almost-identical environment instead of using childEnv(). That copy missed the secret scrubber and the bundled-rg PATH prefix. Both are contract properties, not implementation details: model-run commands must never inherit a connector credential, and `rg` is a runtime the app deliberately ships for those commands.
    const heldSecret = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-must-never-reach-exec-command';
    try {
      const secret = await core('tools/call', {
        name: 'exec_command',
        arguments: {
          cmd: IS_WINDOWS
            ? "if ($env:OPENAI_API_KEY) { Write-Output 'LEAKED' } else { Write-Output 'SCRUBBED' }"
            : "if [ -n \"${OPENAI_API_KEY:-}\" ]; then printf '%s\\n' LEAKED; else printf '%s\\n' SCRUBBED; fi",
          workdir: '/workspace',
          yield_time_ms: 5_000
        }
      });
      expect(failed(secret), textOf(secret)).toBe(false);
      expect(textOf(secret)).toContain('SCRUBBED');
      expect(textOf(secret)).not.toContain('LEAKED');
    } finally {
      if (heldSecret === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = heldSecret;
    }

    const bundled = locateRipgrep();
    if (!bundled) return;
    const rg = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: IS_WINDOWS
          ? "Get-Command rg -CommandType Application | Select-Object -First 1 -ExpandProperty Source"
          : 'command -v rg',
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });
    expect(failed(rg), textOf(rg)).toBe(false);
    expect(textOf(rg).toLowerCase()).toContain(bundled.toLowerCase());
  });

  it.runIf(IS_WINDOWS)('binds bare PowerShell rg to the bundled binary instead of a shadowing function', async () => {
    const bundled = locateRipgrep();
    if (!bundled) return;
    await fs.writeFile(path.join(mcpHarness.approved, 'rg-shadow-target.txt'), 'needle-from-real-ripgrep\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        // A profile function is the live failure mode; defining it inline makes the regression deterministic without touching the user's real PowerShell profile. The app's `rg` contract is the bundled runtime, so this function must never receive the invocation.
        cmd: "function rg { Write-Output 'SHADOWED-RG'; exit 17 }; rg -n needle-from-real-ripgrep rg-shadow-target.txt",
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });

    expect(failed(reply), textOf(reply)).toBe(false);
    expect(textOf(reply)).toContain('needle-from-real-ripgrep');
    expect(textOf(reply)).not.toContain('SHADOWED-RG');
    expect(reply.body.result?.structuredContent?.exit_code).toBe(0);
  });

  it.runIf(IS_WINDOWS)('expands a glob for the bundled ripgrep it just bound the command to', async () => {
    // Binding and expanding are two rewrites of the same command and they were composed in the order that cancels one out: binding turns the leading `rg` into `& '<path>'`, which the normalizer no longer recognises as ripgrep, so every ordinary `rg pattern *.txt` went out with the asterisk still in it. Both halves had unit tests and both passed — they were only ever called separately. This is the pair, through the real tool.
    const bundled = locateRipgrep();
    if (!bundled) return;
    await fs.writeFile(path.join(mcpHarness.approved, 'glob-one.rgtxt'), 'needle-through-the-glob\n', 'utf8');
    await fs.writeFile(path.join(mcpHarness.approved, 'glob-two.rgtxt'), 'nothing here\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'rg -n needle-through-the-glob *.rgtxt',
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });

    expect(failed(reply), textOf(reply)).toBe(false);
    expect(textOf(reply)).toContain('needle-through-the-glob');
    expect(textOf(reply)).toContain('glob-one.rgtxt');
    // The literal asterisk reaching ripgrep is the failure: it reports `os error 123` and the search silently answers nothing.
    expect(textOf(reply)).not.toContain('os error 123');
    expect(reply.body.result?.structuredContent?.exit_code).toBe(0);
  });

  it.runIf(IS_WINDOWS)('normalizes the recorded child-glob and balanced-quote failures through the real tool', async () => {
    const bundled = locateRipgrep();
    if (!bundled) return;
    await fs.mkdir(path.join(mcpHarness.approved, 'test'), { recursive: true });
    await fs.writeFile(path.join(mcpHarness.approved, 'test', 'computer-one.test.ts'), 'from "fsops.js"\n', 'utf8');
    await fs.writeFile(path.join(mcpHarness.approved, 'test', 'computer-two.test.ts'), 'nothing here\n', 'utf8');

    const glob = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'rg -n fsops test/computer*.test.ts',
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });
    expect(failed(glob), textOf(glob)).toBe(false);
    expect(textOf(glob)).toContain('computer-one.test.ts');
    expect(textOf(glob)).not.toContain('os error 123');

    const quote = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: String.raw`rg -n "from ['\"][^'\"]*fsops\.js['\"]" test/computer-one.test.ts`,
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });
    expect(failed(quote), textOf(quote)).toBe(false);
    expect(textOf(quote)).toContain('from "fsops.js"');
    expect(textOf(quote)).not.toContain('regex parse error');
  });

  it('fails closed when an explicit shell name is unknown instead of silently switching languages', async () => {
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'echo must-not-run',
        workdir: '/workspace',
        shell: 'definitely-not-a-shell'
      }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('SHELL_NOT_FOUND');
    expect(textOf(reply)).toContain('No command was run');
  });

  it.runIf(IS_WINDOWS)('does not replace a missing explicit pwsh path with Windows PowerShell 5.1', async () => {
    const missingPwsh = path.join(mcpHarness.approved, 'missing', 'pwsh.exe');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'Write-Output one && Write-Output two',
        workdir: '/workspace',
        shell: missingPwsh
      }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('SHELL_NOT_FOUND');
    expect(textOf(reply)).not.toContain('valid statement separator');
  });

  it('advertises the current exec_command and write_stdin schemas', async () => {
    const tools = toolList(await core('tools/list'));
    const exec = tools.find((tool) => tool.name === 'exec_command')!;
    const stdin = tools.find((tool) => tool.name === 'write_stdin')!;

    expect(Object.keys(exec.inputSchema.properties)).toEqual([
      'cmd',
      'cmds',
      'workdir',
      'tty',
      'yield_time_ms',
      'max_output_tokens',
      'shell',
      'login'
    ]);
    expect(exec.inputSchema.required ?? []).toEqual([]);
    expect(exec.inputSchema.additionalProperties).toBe(false);
    expect(exec.inputSchema.properties.workdir.type).toBe('string');
    expect(exec.inputSchema.properties.cmds.type).toBe('array');
    expect(exec.inputSchema.properties.cmds.items.type).toBe('string');
    expect(String(exec.inputSchema.properties.cmds.description)).toMatch(/one shell session/i);
    expect(String(exec.inputSchema.properties.cmds.description)).toMatch(/exit code/i);
    expect(exec.inputSchema.properties.tty.type).toBe('boolean');
    expect(exec.inputSchema.properties.yield_time_ms.type).toBe('number');
    expect(exec.inputSchema.properties.max_output_tokens.type).toBe('number');
    expect(exec.inputSchema.properties.shell.type).toBe('string');
    expect(exec.inputSchema.properties.login.type).toBe('boolean');
    for (const retired of ['cwd', 'env', 'cols', 'rows', 'max_lines']) {
      expect(exec.inputSchema.properties).not.toHaveProperty(retired);
    }
    expect(exec.outputSchema).toMatchObject({
      type: 'object',
      required: ['wall_time_seconds', 'output'],
      additionalProperties: false
    });

    expect(Object.keys(stdin.inputSchema.properties)).toEqual([
      'session_id',
      'chars',
      'yield_time_ms',
      'max_output_tokens'
    ]);
    expect(stdin.inputSchema.required).toEqual(['session_id']);
    expect(stdin.inputSchema.additionalProperties).toBe(false);
    expect(stdin.inputSchema.properties.session_id.type).toBe('number');
    expect(stdin.inputSchema.properties.chars.type).toBe('string');
    expect(stdin.inputSchema.properties.yield_time_ms.type).toBe('number');
    expect(stdin.inputSchema.properties.max_output_tokens.type).toBe('number');
    for (const retired of ['cursor', 'close', 'signal', 'env', 'max_lines']) {
      expect(stdin.inputSchema.properties).not.toHaveProperty(retired);
    }
    expect(stdin.outputSchema).toEqual(exec.outputSchema);
  });

  it('runs cmds sequentially in one shell with labeled per-command exit codes', async () => {
    const commands = IS_WINDOWS
      ? [
          "$measuredBatchValue='same-shell'",
          'Write-Output "value=$measuredBatchValue"; cmd /c exit 7',
          'Write-Output "after=$measuredBatchValue"'
        ]
      : [
          "measuredBatchValue='same-shell'",
          "printf 'value=%s\\n' \"$measuredBatchValue\"; sh -c 'exit 7'",
          "printf 'after=%s\\n' \"$measuredBatchValue\""
        ];
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmds: commands,
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });
    const text = textOf(reply);
    expect(failed(reply), text).toBe(false);
    expect(text).toContain('--- command 1/3 ---');
    expect(text).toContain('--- command 2/3 ---');
    expect(text).toContain('--- command 3/3 ---');
    expect(text).toContain('--- exit code 7 ---');
    expect(text).toContain('value=same-shell');
    expect(text).toContain('after=same-shell');
    expect(reply.body.result?.structuredContent).toMatchObject({ exit_code: 7 });

    for (const arguments_ of [{}, { cmd: 'echo one', cmds: ['echo two'] }]) {
      const invalid = await core('tools/call', { name: 'exec_command', arguments: arguments_ });
      expect(failed(invalid), textOf(invalid)).toBe(true);
      expect(textOf(invalid)).toMatch(/exactly one of cmd or cmds/i);
    }
  });

  /** Both of these run a real ripgrep through the batch runner, so they need one to exist — `resources/rg` from packaging, or a copy on PATH. Without either, `rg` is not a command and the batch reports 127, which says nothing about per-command exit accounting. Skip rather than fail: the subject is the accounting, not whether this checkout ships the tool. */
  const ripgrep = locateRipgrep();

  it.skipIf(!ripgrep)('reads a batch exit per command, so one search finding nothing is not a failure', async () => {
    // The batch that `cmds` exists for is several searches at once, and a search that finds nothing exits 1. Handing the wrapper script to the single-command classifier would ask whether a `for` loop is a search, so the batch used to report a plain failure and invite the model to run all of it again — the exact round trip batching was meant to remove.
    const searches = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        // `notes.txt` is intentionally overwritten by an earlier apply_patch regression in this same end-to-end suite. Search an immutable fixture so the test does not depend on file-order side effects that happened to differ across hosts.
        cmds: ['rg -n "export const name" src/app.ts', 'rg -n "no-such-pattern-anywhere" src/app.ts'],
        workdir: '/workspace',
        yield_time_ms: 8_000
      }
    });
    const searchText = textOf(searches);
    expect(searchText).toContain('--- exit code 1 ---');
    // Named per command, because only one of the two is the one that found nothing.
    expect(searchText).toMatch(/Command 2: Exit code 1 from/);
    expect(searchText).toContain('is a result, not a failure');

    // A real failure inside a batch stays a failure and gets no exoneration.
    const broken = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmds: IS_WINDOWS ? ['Write-Output first', 'cmd /c exit 3'] : ["printf '%s\\n' first", "sh -c 'exit 3'"],
        workdir: '/workspace',
        yield_time_ms: 8_000
      }
    });
    const brokenText = textOf(broken);
    expect(brokenText).toContain('--- exit code 3 ---');
    expect(brokenText).not.toContain('is a result, not a failure');
    // One exit code stands for two commands; the note says which one it came from.
    expect(brokenText).toContain('Batch: command 2 exited 3; the other command exited 0.');
  }, 60_000);

  it.skipIf(!ripgrep)('returns partial search results without exonerating an unreadable batch path', async () => {
    const result = await core('tools/call', { name: 'exec_command', arguments: {
      cmds: ['rg -n "export const name" src/app.ts missing-search-file.ts', 'rg -n "export const name" src/app.ts'],
      workdir: '/workspace', yield_time_ms: 8_000
    } });
    expect(result.body.result?.structuredContent).toMatchObject({ exit_code: 2 });
    expect(textOf(result)).toContain('export const name');
    expect(textOf(result)).toContain('Batch: command 1 exited 2; the other command exited 0.');
    expect(textOf(result)).toContain('incomplete');
    expect(textOf(result)).not.toContain('not a failed search');
  });

  it.skipIf(!IS_WINDOWS)('scopes parser recovery to its failed batch command after an earlier mutation', async () => {
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmds: [
          "Set-Content -LiteralPath batch-parser-proof.txt -Value saved; Write-Output 'ParserError: source text only'",
          "Write-Output 'unterminated"
        ],
        workdir: '/workspace',
        yield_time_ms: 8_000
      }
    });
    const text = textOf(reply);
    expect(text).toContain('Batch: command 2 exited 1; the other command exited 0.');
    expect(text).toContain('Note: Command 2: PowerShell parsed none of the command');
    expect(text).not.toContain('Note: Command 1:');
    expect(text).not.toContain('Note: PowerShell parsed none');
    const proof = await core('tools/call', {
      name: 'read', arguments: { paths: ['/workspace/batch-parser-proof.txt'] }
    });
    expect(textOf(proof)).toContain('saved');
  });

  it('uses consistent response and session rules for quick and interactive commands', async () => {
    const quick = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: IS_WINDOWS ? "Write-Output 'quick-ok'" : "printf '%s\\n' quick-ok",
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });
    expect(quick.body.result?.isError).not.toBe(true);
    expect(textOf(quick)).toContain('quick-ok');
    expect(textOf(quick)).toContain('Process exited with code 0');
    expect(textOf(quick)).toContain('Chunk ID:');
    expect(quick.body.result?.structuredContent).toMatchObject({
      exit_code: 0,
      output: expect.stringContaining('quick-ok')
    });
    expect(typeof quick.body.result?.structuredContent?.chunk_id).toBe('string');
    expect(typeof quick.body.result?.structuredContent?.wall_time_seconds).toBe('number');

    await fs.writeFile(
      path.join(mcpHarness.approved, 'interactive-stdin.cjs'),
      "const readline=require('node:readline'); const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); let n=0; rl.on('line',(line)=>{n++; console.log((n===1?'first=':'second=')+line); if(n===2) rl.close();});\n",
      'utf8'
    );
    const started = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'node interactive-stdin.cjs',
        workdir: '/workspace',
        tty: true,
        yield_time_ms: 25
      }
    });
    expect(started.body.result?.isError).not.toBe(true);
    expect(textOf(started)).toContain('Process running with session ID');
    const sessionIdText = textOf(started).match(/Process running with session ID (\d+)/)?.[1];
    expect(sessionIdText).toBeTruthy();
    const sessionId = Number(sessionIdText);

    // write_stdin sends bytes exactly as supplied. Without a newline ReadLine must keep waiting.
    const partial = await core('tools/call', {
      name: 'write_stdin',
      arguments: {
        session_id: sessionId,
        chars: 'raw-no-newline',
        yield_time_ms: 250
      }
    });
    expect(partial.body.result?.isError).not.toBe(true);
    expect(textOf(partial)).toContain(`Process running with session ID ${sessionId}`);
    expect(textOf(partial)).not.toContain('first=');

    const first = await core('tools/call', {
      name: 'write_stdin',
      arguments: { session_id: sessionId, chars: '\r', yield_time_ms: 5_000 }
    });
    expect(first.body.result?.isError).not.toBe(true);
    expect(textOf(first)).toContain('first=raw-no-newline');
    expect(textOf(first)).toContain(`Process running with session ID ${sessionId}`);

    // Check the unread cursor while the child is still idle. ConPTY may emit a *new* screen repaint containing the first line when the console exits; those bytes are not a replay by NEURAFLOK and must stay in the raw terminal stream.
    const idle = await core('tools/call', {
      name: 'write_stdin',
      arguments: { session_id: sessionId, chars: '', yield_time_ms: 1_000 }
    });
    expect(idle.body.result?.isError).not.toBe(true);
    expect(idle.body.result?.structuredContent?.output).toBe('');
    expect(textOf(idle)).toContain(`Process running with session ID ${sessionId}`);

    const second = await core('tools/call', {
      name: 'write_stdin',
      arguments: { session_id: sessionId, chars: 'done\r', yield_time_ms: 5_000 }
    });
    expect(second.body.result?.isError).not.toBe(true);
    expect(textOf(second)).toContain('second=done');
    expect(textOf(second)).toContain('Process exited with code 0');
    expect(second.body.result?.structuredContent?.output_replayed).not.toBe(true);
  });

  it('runs in workdir and omits the old connector-specific cwd header', async () => {
    const readApp = IS_WINDOWS ? "Get-Content 'src/app.ts'" : "cat 'src/app.ts'";
    const named = await core('tools/call', {
      name: 'exec_command',
      arguments: { cmd: readApp, workdir: '/workspace', yield_time_ms: 5_000 }
    });
    expect(named.body.result?.isError).not.toBe(true);
    expect(textOf(named)).toContain('export const name = "app";');
    expect(textOf(named)).not.toContain('cwd: /workspace');

    const defaulted = await core('tools/call', {
      name: 'exec_command',
      arguments: { cmd: readApp, yield_time_ms: 5_000 }
    });
    expect(defaulted.body.result?.isError).not.toBe(true);
    expect(textOf(defaulted)).toContain('export const name = "app";');
    expect(textOf(defaulted)).not.toContain('default — no cwd was given');
  });

  it.runIf(IS_WINDOWS)('preserves raw merged output instead of converting it to CLIXML', async () => {
    const payload =
      '#< CLIXML<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<S S="Error">An empty pipe element is not allowed._x000D__x000A_</S></Objs>';
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: `[Console]::Error.Write('${payload}')`,
        workdir: '/workspace',
        yield_time_ms: 8_000
      }
    });
    expect(reply.body.result?.isError).not.toBe(true);
    expect(textOf(reply)).toContain('Output:');
    expect(textOf(reply)).toContain('#< CLIXML');
    expect(textOf(reply)).toContain('_x000D__x000A_');
  });
});
