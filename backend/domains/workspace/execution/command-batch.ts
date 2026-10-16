// Frames sequential command output with invocation-scoped markers.

import { randomBytes } from 'node:crypto';
import type { ShellType } from './shell.js';

const BATCH_MARKER_BYTES = 12;
const FRAME_PREFIX = '__NEURAFLOK_BATCH_V1_';
const FRAME_END = '__';
const MAX_FRAME_PAYLOAD_BYTES = 40;

function batchMarker(): string {
  return randomBytes(BATCH_MARKER_BYTES).toString('hex');
}

function commandFrame(index: number, count: number, marker: string): string {
  return `${FRAME_PREFIX}${marker}_C${index}_${count}${FRAME_END}`;
}

function exitFrame(code: string, marker: string): string {
  return `${FRAME_PREFIX}${marker}_E${code}${FRAME_END}`;
}

function commandLabel(index: number, count: number): string {
  return `--- command ${index}/${count} ---`;
}

function exitLabel(code: string): string {
  return `--- exit code ${code} ---`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellBatch(commands: readonly string[], marker: string): string {
  const encoded = commands.map((command) => Buffer.from(command, 'utf8').toString('base64'));
  return [
    `$__neuraflok_batch_commands = @(${encoded.map((item) => `'${item}'`).join(', ')})`,
    '$__neuraflok_batch_exit = 0',
    'for ($__neuraflok_batch_index = 0; $__neuraflok_batch_index -lt $__neuraflok_batch_commands.Count; $__neuraflok_batch_index++) {',
    `  [Console]::Out.WriteLine("${FRAME_PREFIX}${marker}_C$($__neuraflok_batch_index + 1)_${commands.length}__")`,
    '  $global:LASTEXITCODE = 0',
    '  try {',
    '    $__neuraflok_batch_text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__neuraflok_batch_commands[$__neuraflok_batch_index]))',
    '    . ([ScriptBlock]::Create($__neuraflok_batch_text))',
    '    $__neuraflok_batch_succeeded = $?',
    '    $__neuraflok_batch_code = if ($LASTEXITCODE -ne 0) { [int]$LASTEXITCODE } elseif ($__neuraflok_batch_succeeded) { 0 } else { 1 }',
    '  } catch {',
    '    [Console]::Error.WriteLine($_.ToString())',
    '    $__neuraflok_batch_code = 1',
    '  }',
    '  [Console]::Out.WriteLine()',
    '  [Console]::Out.WriteLine("' + FRAME_PREFIX + marker + '_E${__neuraflok_batch_code}__")',
    '  if ($__neuraflok_batch_code -ne 0 -and $__neuraflok_batch_exit -eq 0) { $__neuraflok_batch_exit = $__neuraflok_batch_code }',
    '}',
    'exit $__neuraflok_batch_exit'
  ].join('\n');
}

function posixBatch(commands: readonly string[], marker: string): string {
  const lines = ['__neuraflok_batch_exit=0'];
  commands.forEach((command, index) => {
    lines.push(
      `printf '%s\\n' ${shellSingleQuote(commandFrame(index + 1, commands.length, marker))}`,
      `eval ${shellSingleQuote(command)}`,
      '__neuraflok_batch_code=$?',
      `printf '\\n%s%s%s\\n' ${shellSingleQuote(`${FRAME_PREFIX}${marker}_E`)} "$__neuraflok_batch_code" '__'`,
      'if [ "$__neuraflok_batch_code" -ne 0 ] && [ "$__neuraflok_batch_exit" -eq 0 ]; then __neuraflok_batch_exit=$__neuraflok_batch_code; fi'
    );
  });
  lines.push('exit "$__neuraflok_batch_exit"');
  return lines.join('\n');
}

function cmdBatch(commands: readonly string[], marker: string): string {
  const lines = ['@echo off', 'set "__neuraflok_batch_exit=0"'];
  commands.forEach((command, index) => {
    lines.push(
      `echo ${commandFrame(index + 1, commands.length, marker)}`,
      `call ${command}`,
      'set "__neuraflok_batch_code=%errorlevel%"',
      'echo(',
      `echo ${exitFrame('%__neuraflok_batch_code%', marker)}`,
      'if not "%__neuraflok_batch_code%"=="0" if "%__neuraflok_batch_exit%"=="0" set "__neuraflok_batch_exit=%__neuraflok_batch_code%"'
    );
  });
  lines.push('exit /b %__neuraflok_batch_exit%');
  return lines.join('\r\n');
}

export function composeCommandBatch(commands: readonly string[], shellType: ShellType): { command: string; marker: string } {
  if (commands.length === 0) throw new Error('a command batch must contain at least one command');
  const marker = batchMarker();
  switch (shellType) {
    case 'powershell':
      return { command: powershellBatch(commands, marker), marker };
    case 'cmd':
      return { command: cmdBatch(commands, marker), marker };
    case 'bash':
    case 'zsh':
    case 'sh':
      return { command: posixBatch(commands, marker), marker };
  }
}

function frameLabel(token: string, marker: string): string | null {
  const match = new RegExp(`^${FRAME_PREFIX}${marker}_(?:C(\\d+)_(\\d+)|E(-?\\d+))${FRAME_END}$`).exec(token);
  if (!match) return null;
  if (match[1] && match[2]) {
    const index = Number(match[1]);
    const count = Number(match[2]);
    return Number.isSafeInteger(index) && Number.isSafeInteger(count) && index > 0 && count > 0
      ? commandLabel(index, count)
      : null;
  }
  const code = Number(match[3]);
  return Number.isSafeInteger(code) ? exitLabel(match[3]!) : null;
}

function trailingPrefixLength(input: Buffer, prefix: Buffer, start: number): number {
  for (let size = Math.min(prefix.length - 1, input.length - start); size > 0; size--) {
    if (input.subarray(input.length - size).equals(prefix.subarray(0, size))) return size;
  }
  return 0;
}

// Replaces complete private frames while preserving arbitrary streamed output bytes.
export class CommandBatchDisplay {
  private readonly marker: string;
  private readonly prefix: Buffer;
  private pending = Buffer.alloc(0);

  constructor(marker: string) {
    if (!/^[0-9a-f]{24}$/.test(marker)) throw new Error('invalid command batch marker');
    this.marker = marker;
    this.prefix = Buffer.from(`${FRAME_PREFIX}${marker}_`);
  }

  push(chunk: Buffer, final = false): Buffer {
    const input = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const parts: Buffer[] = [];
    this.pending = Buffer.alloc(0);
    let cursor = 0;

    while (cursor < input.length) {
      const start = input.indexOf(this.prefix, cursor);
      if (start < 0) {
        const held = final ? 0 : trailingPrefixLength(input, this.prefix, cursor);
        const end = input.length - held;
        if (end > cursor) parts.push(input.subarray(cursor, end));
        if (held > 0) this.pending = Buffer.from(input.subarray(end));
        cursor = input.length;
        continue;
      }

      if (start > cursor) parts.push(input.subarray(cursor, start));
      const payloadStart = start + this.prefix.length;
      const end = input.indexOf(FRAME_END, payloadStart);
      if (end < 0) {
        const payloadLength = input.length - payloadStart;
        if (!final && payloadLength <= MAX_FRAME_PAYLOAD_BYTES) {
          this.pending = Buffer.from(input.subarray(start));
          cursor = input.length;
          continue;
        }
        if (final) {
          parts.push(input.subarray(start));
          cursor = input.length;
          continue;
        }
        parts.push(input.subarray(start, start + 1));
        cursor = start + 1;
        continue;
      }

      if (end - payloadStart > MAX_FRAME_PAYLOAD_BYTES) {
        parts.push(input.subarray(start, start + 1));
        cursor = start + 1;
        continue;
      }

      const frameEnd = end + FRAME_END.length;
      const label = frameLabel(input.subarray(start, frameEnd).toString('ascii'), this.marker);
      if (label) parts.push(Buffer.from(label, 'utf8'));
      else parts.push(input.subarray(start, frameEnd));
      cursor = frameEnd;
    }

    return Buffer.concat(parts);
  }
}

// Holds one complete command result recovered from its framing markers.
export interface CommandBatchSection {
  // The command's one-based position in the submitted batch.
  index: number;
  exitCode: number;
  // Output between the command banner and its exit marker.
  text: string;
}

function removeWrapperNewline(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function removeFrameLineEnding(value: string): string {
  if (value.startsWith('\r\n')) return value.slice(2);
  return value.startsWith('\n') ? value.slice(1) : value;
}

function framePattern(marker: string): RegExp {
  return new RegExp(`${FRAME_PREFIX}${marker}_(?:C([1-9]\\d*)_([1-9]\\d*)|E(-?\\d+))${FRAME_END}`, 'g');
}

// Reads complete sections in order and ignores incomplete command tails.
export function parseCommandBatchSections(output: string, marker: string): CommandBatchSection[] {
  const sections: CommandBatchSection[] = [];
  if (!/^[0-9a-f]{24}$/.test(marker)) return sections;

  const pattern = framePattern(marker);
  const frames: Array<{ start: number; end: number; index?: number; count?: number; exitCode?: number }> = [];
  for (let match = pattern.exec(output); match; match = pattern.exec(output)) {
    const index = match[1] ? Number(match[1]) : undefined;
    const count = match[2] ? Number(match[2]) : undefined;
    const exitCode = match[3] ? Number(match[3]) : undefined;
    if (index !== undefined && (!Number.isSafeInteger(index) || !Number.isSafeInteger(count))) continue;
    if (exitCode !== undefined && !Number.isSafeInteger(exitCode)) continue;
    frames.push({ start: match.index, end: match.index + match[0].length, index, count, exitCode });
  }

  let firstFrame = 0;
  while (firstFrame < frames.length && (frames[firstFrame]!.index !== 1 || !frames[firstFrame]!.count)) firstFrame++;
  if (firstFrame >= frames.length) return sections;

  const count = frames[firstFrame]!.count!;
  let currentIndex = 1;
  let openFrame: (typeof frames)[number] | null = frames[firstFrame]!;
  for (let position = firstFrame + 1; position < frames.length; position++) {
    const frame = frames[position]!;
    if (openFrame) {
      if (frame.exitCode === undefined) continue;
      const framedText = removeFrameLineEnding(output.slice(openFrame.end, frame.start));
      const text = removeWrapperNewline(framedText).replace(/\r\n/g, '\n');
      sections.push({ index: currentIndex, exitCode: frame.exitCode, text });
      currentIndex++;
      openFrame = null;
      continue;
    }
    if (frame.index === undefined) continue;
    if (frame.index !== currentIndex || frame.count !== count || currentIndex > count) break;
    openFrame = frame;
  }
  return sections;
}
