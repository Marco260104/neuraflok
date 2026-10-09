import {
  emptyEvidence,
  evidence,
  summarizeToolCall,
} from './context.js';
import type {
  ToolOutcome,
} from './context.js';
import { describe, expect, it } from 'vitest';

// --------------------------------------------------------------- summaries

describe('tool summaries', () => {
  const summarize = (tool: string, args: unknown, patch: Partial<ReturnType<typeof emptyEvidence>> = {}, outcome: ToolOutcome = 'ok', durationMs = 10) =>
    summarizeToolCall({ tool, args, evidence: evidence(patch), outcome, durationMs, resultHead: 'head line' });

  /** The patch text a summary reads its intent off. */
  const patch = (header: string, path: string): string =>
    `*** Begin Patch\n*** ${header}: ${path}\n*** End Patch`;

  it('names one edited file and totals several', () => {
    const one = summarize('apply_patch', { patch: patch('Update File', '/p/src/a.ts') }, {
      changes: [{ path: '/p/src/a.ts', added: 18, removed: 4, approximate: false }]
    });
    expect(one.title).toBe('Edited a.ts in src');
    expect(one.metric).toBe('+18 −4');

    const many = summarize('apply_patch', { patch: patch('Update File', '/p/a.ts') }, {
      changes: [
        { path: '/p/a.ts', added: 40, removed: 9, approximate: false },
        { path: '/p/b.ts', added: 32, removed: 10, approximate: false }
      ]
    });
    expect(many.title).toBe('Edited 2 files');
    expect(many.metric).toBe('+72 −19');
  });

  it('marks an approximate diffstat rather than pretending it is exact', () => {
    const summary = summarize('apply_patch', { patch: patch('Update File', '/p/big.ts') }, {
      changes: [{ path: '/p/big.ts', added: 4000, removed: 3000, approximate: true }]
    });
    expect(summary.metric).toBe('~+4000 −3000');
  });

  // One tool now covers create, edit, move and delete, so the title has to come from what the patch did. A timeline that said "Applied a patch" four times would be useless.
  it('tells creates, deletes and moves apart from the patch itself', () => {
    expect(summarize('apply_patch', { patch: patch('Add File', '/p/src/history.ts') }, {
      changes: [{ path: '/p/src/history.ts', added: 214, removed: 0, approximate: false }]
    })).toMatchObject({ title: 'Created history.ts in src', metric: '+214', kind: 'create' });

    expect(summarize('apply_patch', { patch: patch('Delete File', '/p/old-helper.ts') }, {
      changes: [{ path: '/p/old-helper.ts', added: 0, removed: 83, approximate: false }]
    })).toMatchObject({ title: 'Deleted old-helper.ts', metric: '−83', tone: 'warn', kind: 'delete' });

    const moved = summarize(
      'apply_patch',
      { patch: '*** Begin Patch\n*** Move to: /p/new.ts\n*** End Patch' },
      { changes: [{ path: '/p/new.ts', added: 0, removed: 0, approximate: false }] }
    );
    expect(moved).toMatchObject({ title: 'Moved new.ts', kind: 'move' });

    // A patch that both adds and updates is simply an edit; it must not claim to be a create.
    const mixed = summarize(
      'apply_patch',
      { patch: `${patch('Add File', '/p/a.ts')}\n*** Update File: /p/b.ts` },
      {
        changes: [
          { path: '/p/a.ts', added: 5, removed: 0, approximate: false },
          { path: '/p/b.ts', added: 1, removed: 1, approximate: false }
        ]
      }
    );
    expect(mixed.kind).toBe('edit');
  });

  it('describes a read by its paths and range', () => {
    expect(summarize('read', { paths: ['/p/tools.ts'], start_line: 200, end_line: 420 })).toMatchObject({
      title: 'Read tools.ts',
      detail: 'lines 200–420',
      metric: '221 lines'
    });
    expect(
      summarize('read', { paths: ['/p/tools.ts'], start_line: 200, end_line: 420 }, { detail: 'lines 200–237' })
    ).toMatchObject({ detail: 'lines 200–237', metric: '38 lines' });
    expect(summarize('read', { paths: ['/p/a.ts', '/p/b.ts', '/p/c.ts'] })).toMatchObject({
      title: 'Read 3 paths',
      detail: 'a.ts, b.ts, c.ts'
    });
  });

  it('reports how a command exited', () => {
    expect(summarize('exec_command', { cmd: 'npm run verify' }, { exitCode: 0, durationMs: 4800 })).toMatchObject({
      title: 'Ran the verify script',
      metric: '✓ 4.8s',
      tone: 'good'
    });
    const failed = summarize('exec_command', { cmd: 'npm test' }, { exitCode: 1, durationMs: 900 });
    expect(failed.title).toContain('Command failed');
    expect(failed.metric).toBe('✕ exit 1');
    expect(failed.tone).toBe('bad');
    expect(summarize('exec_command', { cmd: 'sleep 100' }, { exitCode: null, timedOut: true }).metric).toBe(
      '✕ timed out'
    );
    expect(
      summarize('exec_command', { cmd: 'npm run verify' }, { exitCode: null, durationMs: 10_000 })
    ).toMatchObject({ title: 'Started the verify script', metric: 'started', tone: 'neutral' });
  });

  it('says which way a session was interrupted', () => {
    expect(summarize('write_stdin', { session_id: 'p1', signal: 'kill' })).toMatchObject({
      title: 'Stopped session p1',
      tone: 'warn'
    });
    expect(summarize('write_stdin', { session_id: 'p1', signal: 'int' }).title).toBe('Interrupted session p1');
    expect(summarize('write_stdin', { session_id: 'p1', chars: 'y\n' }).title).toBe('Wrote to session p1');
    expect(summarize('write_stdin', { session_id: 'p1' }).title).toBe('Waited on session p1');
  });

  it('keeps the subject but not the claim when a call fails or is refused', () => {
    const refused = summarize('apply_patch', { patch: patch('Delete File', '/p/x.ts') }, {
      changes: [{ path: '/p/x.ts', added: 0, removed: 3, approximate: false }]
    }, 'tool_rejected');
    expect(refused.title).toBe('Refused to delete x.ts');
    expect(refused.metric).toBe('refused');
    expect(refused.tone).toBe('warn');

    const errored = summarize('apply_patch', { patch: patch('Update File', '/p/x.ts') }, {
      changes: [{ path: '/p/x.ts', added: 1, removed: 1, approximate: false }]
    }, 'tool_internal_error');
    expect(errored.title).toBe('Could not edit x.ts');
    expect(errored.metric).toBe('✕ failed');
    expect(errored.detail).toBe('head line');
    expect(errored.tone).toBe('bad');
  });

  it('says a failed call failed in words, for every tool family', () => {
    const cases: Array<[string, unknown, string]> = [
      ['read', { paths: ['/p/x.ts'] }, 'Could not read x.ts'],
      ['find', { query: 'todo' }, 'Could not search "todo"'],
      ['apply_patch', { patch: patch('Update File', '/p/x.ts') }, 'Could not apply a patch'],
      ['exec_command', { cmd: 'npm test' }, 'Could not run tests'],
      ['observe', {}, 'Could not look at the screen'],
      ['agents', { action: 'spawn', workers: [{ task: 'a' }, { task: 'b' }] }, 'Could not create 2 worker agents'],
      [
        'agents',
        { action: 'message', messages: [{ to: 'worker-1', text: 'a' }, { to: 'worker-2', text: 'b' }] },
        'Could not message 2 agents'
      ],
      ['agents', { action: 'finish', result: 'done' }, 'Could not report the finished task'],
      ['some_future_tool', {}, 'Could not run some_future_tool']
    ];
    for (const [tool, args, title] of cases) {
      const summary = summarize(tool, args, {}, 'tool_internal_error');
      expect(summary.title, tool).toBe(title);
      // Nothing may still read as an accomplished action.
      expect(summary.title, tool).not.toMatch(/^(Read|Applied|Created|Searched|Ran|Messaged|Reported|Looked) /);
    }
  });

  it('reads the action out of the flat session and agents tools', () => {
    expect(summarize('agents', { action: 'spawn', workers: [{ task: 'a' }, { task: 'b' }] }).title).toBe(
      'Created 2 worker agents'
    );
    expect(summarize('agents', { action: 'message', to: 'worker-2' }).title).toBe('Messaged worker-2');
    expect(summarize('agents', { action: 'status' }).title).toBe('Checked agent status');
    expect(summarize('session', { action: 'search', query: 'tunnel' }).title).toBe(
      'Searched recordings "tunnel"'
    );
    expect(summarize('session', { action: 'search' }).title).toBe('Listed recent recordings');
    expect(summarize('session', { action: 'read', session_id: 'session-one' }).title).toBe(
      'Read a recorded session'
    );
    expect(summarize('session', { action: 'read', session_id: 'session-one', cursor: 'opaque' }).title).toBe(
      'Continued reading a recorded session'
    );
  });

  it('names the desktop action rather than saying "computer"', () => {
    expect(summarize('computer', { actions: [{ type: 'click_ref', ref: 'e1' }] })).toMatchObject({
      title: 'Clicked',
      kind: 'input'
    });
    // Clipboard-only work is not desktop input and should not read as if it were.
    expect(summarize('computer', { actions: [{ type: 'read_clipboard' }] })).toMatchObject({
      title: 'Read the clipboard',
      kind: 'clipboard'
    });
    expect(
      summarize('computer', { actions: [{ type: 'write_clipboard', text: 'x' }, { type: 'keypress', keys: ['ctrl', 'v'] }] })
    ).toMatchObject({ kind: 'input', detail: '2 actions' });
  });

  it('names the action instead of the raw command', () => {
    const single = summarize('exec_command', { cmd: 'Get-Process -Name node' }, { exitCode: 0, durationMs: 120 });
    expect(single.title).toBe('Listed processes');

    const listed = summarize(
      'exec_command',
      { cmd: '# find the build\r\nGet-ChildItem -Recurse -Filter *.log\nSelect-Object -First 5' },
      { exitCode: 0, durationMs: 120 }
    );
    expect(listed.title).toBe('Listed files');

    expect(summarize('exec_command', { cmd: 'cat src/a.ts' }, { exitCode: 0, durationMs: 20 }).title).toBe(
      'Read a.ts in src'
    );
    expect(summarize('exec_command', { cmd: 'npm test' }, { exitCode: 0, durationMs: 800 }).title).toBe('Ran tests');

    const long = summarize('exec_command', { cmd: `Write-Output ${'x'.repeat(200)}` }, { exitCode: 0 });
    expect(long.title).toBe('Wrote output');
    expect(long.title.length).toBeLessThan(90);

    expect(summarize('exec_command', {}, { exitCode: 1, durationMs: 5 }).title).toBe('Command failed a command');
  });

  it('falls back to the tool name rather than "Called tool"', () => {
    expect(summarize('some_future_tool', {}).title).toBe('Ran some_future_tool');
  });
});
