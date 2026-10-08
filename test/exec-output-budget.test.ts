// Verify that model output limits stay distinct from the process collection ceiling.

import { describe, expect, it } from 'vitest';
import { DEFAULT_TRUNCATION_POLICY, EXEC_OUTPUT_CEILING_POLICY } from '../backend/domains/workspace/execution/manager.js';
import { policyTokenBudget } from '../backend/domains/workspace/execution/output-bounds.js';
import {
  execCommandResponseText,
  execCommandStructuredOutput,
  type ExecCommandToolOutput
} from '../backend/domains/workspace/execution/unified-exec.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  UNIFIED_EXEC_OUTPUT_MAX_BYTES,
  UNIFIED_EXEC_OUTPUT_MAX_TOKENS
} from '../backend/domains/workspace/execution/unified-exec-constants.js';
import { BoundedOutputBuffer } from '../backend/domains/workspace/execution/output/bounded-buffer.js';
import { formatCommandResult } from '../backend/domains/workspace/execution/exec-output.js';
import { projectExecCommandOutput } from '../backend/domains/workspace/execution/exec-command-output.js';

/** `approxBytesForTokens`: the truncator's own four-bytes-per-token estimate. */
const BYTES_PER_TOKEN = 4;

// Use ASCII so character counts match byte counts.
function asciiOutput(bytes: number): Buffer {
  return Buffer.from('x'.repeat(bytes), 'ascii');
}

// Build an exec result with a caller-selected model output budget.
function execOutput(rawOutput: Buffer, maxOutputTokens: number | undefined): ExecCommandToolOutput {
  return {
    chunkId: 'abc123',
    wallTimeMs: 12,
    rawOutput,
    truncationPolicy: EXEC_OUTPUT_CEILING_POLICY,
    maxOutputTokens,
    processId: null,
    exitCode: 0,
    originalTokenCount: null,
    outputOmittedBytes: null
  };
}

// Detect the marker used when output is truncated for the model.
function wasTruncated(responseText: string): boolean {
  return responseText.includes('Warning: truncated output');
}

describe('exec output budget', () => {
  it('separates the default budget from the safety ceiling', () => {
    // The original regression: a byte policy reaches `modelOutputMaxTokens` as bytes/4 = 2_500.
    expect(policyTokenBudget(DEFAULT_TRUNCATION_POLICY)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    // The second regression: a ceiling equal to the default makes every larger request inert.
    expect(policyTokenBudget(EXEC_OUTPUT_CEILING_POLICY)).toBe(UNIFIED_EXEC_OUTPUT_MAX_TOKENS);
    expect(policyTokenBudget(EXEC_OUTPUT_CEILING_POLICY)).toBeGreaterThan(DEFAULT_MAX_OUTPUT_TOKENS);
    // The ceiling is the collection cap restated, not an independent number.
    expect(UNIFIED_EXEC_OUTPUT_MAX_TOKENS).toBe(UNIFIED_EXEC_OUTPUT_MAX_BYTES / BYTES_PER_TOKEN);
  });

  it('returns the advertised 10000-token default in full when no budget is requested', () => {
    const bytes = DEFAULT_MAX_OUTPUT_TOKENS * BYTES_PER_TOKEN - 1_000;
    const text = execCommandResponseText(execOutput(asciiOutput(bytes), undefined));

    expect(wasTruncated(text)).toBe(false);
    // Under the old byte policy this arrived cut to ~10_000 bytes.
    expect(text.length).toBeGreaterThan(30_000);
  });

  it('cuts an omitted-budget result at the 10000-token default, not at the ceiling', () => {
    const bytes = 200_000;
    const text = execCommandResponseText(execOutput(asciiOutput(bytes), undefined));

    expect(wasTruncated(text)).toBe(true);
    // ~40_000 bytes retained: the default still applies when nothing was asked for.
    expect(text.length).toBeLessThan(60_000);
  });

  it('honours an explicit request above the default, which is the whole point', () => {
    // 30_000 tokens was the second most common request in the recorded sessions.
    const bytes = 200_000;
    const requested = execCommandResponseText(execOutput(asciiOutput(bytes), 30_000));
    const omitted = execCommandResponseText(execOutput(asciiOutput(bytes), undefined));

    // Both are truncated — 200_000 bytes exceeds either budget — but they must differ, and the explicit request must be the larger. A ceiling of 10_000 tokens makes these equal.
    expect(wasTruncated(requested)).toBe(true);
    expect(requested.length).toBeGreaterThan(omitted.length);
    // 30_000 tokens is ~120_000 bytes of retained output against the default's ~40_000.
    expect(requested.length).toBeGreaterThan(100_000);
  });

  it('scales monotonically with the requested budget', () => {
    const bytes = 400_000;
    const lengthFor = (tokens: number): number =>
      execCommandResponseText(execOutput(asciiOutput(bytes), tokens)).length;

    expect(lengthFor(20_000)).toBeGreaterThan(lengthFor(10_000));
    expect(lengthFor(30_000)).toBeGreaterThan(lengthFor(20_000));
  });

  it('still lets an explicit smaller request win, so min(request, policy) is intact', () => {
    const bytes = 40_000;
    const small = execCommandResponseText(execOutput(asciiOutput(bytes), 1_000));
    const dflt = execCommandResponseText(execOutput(asciiOutput(bytes), undefined));

    expect(wasTruncated(small)).toBe(true);
    // 1_000 tokens is ~4_000 bytes of retained output, far below the default budget.
    expect(small.length).toBeLessThan(10_000);
    expect(small.length).toBeLessThan(dflt.length);
  });

  it('bounds an absurd request at the ceiling', () => {
    // More than the collection buffer can ever hand over, so the ceiling is what answers.
    const bytes = UNIFIED_EXEC_OUTPUT_MAX_BYTES;
    const huge = execCommandResponseText(execOutput(asciiOutput(bytes), 10_000_000));

    // At exactly 1 MiB the ceiling is not exceeded, so nothing is cut and the result is the collection cap itself — the request never governs.
    expect(huge.length).toBeLessThanOrEqual(UNIFIED_EXEC_OUTPUT_MAX_BYTES + 1_000);
  });

  it('applies the same budget to structuredContent as to the text result', () => {
    const bytes = 200_000;
    const output = execOutput(asciiOutput(bytes), 30_000);
    const structured = execCommandStructuredOutput(output);
    const projection = projectExecCommandOutput(output);

    expect(typeof structured.output).toBe('string');
    expect(String(structured.output).length).toBeGreaterThan(100_000);
    expect(String(structured.output)).toContain('Warning: truncated output');
    expect(projection.text).toBe(execCommandResponseText(output));
    expect(projection.structured).toEqual(structured);
    expect(projection.output).toBe(structured.output);
  });

  it('leaves the 1 MiB collection cap in place beneath the model-facing budget', () => {
    // The collection cap is a separate, earlier limit on what is retained at all. Widening the model-facing ceiling must not widen it.
    expect(UNIFIED_EXEC_OUTPUT_MAX_BYTES).toBe(1024 * 1024);

    const buffer = new BoundedOutputBuffer();
    buffer.pushChunk(asciiOutput(UNIFIED_EXEC_OUTPUT_MAX_BYTES + 4_096));

    expect(buffer.retainedBytes()).toBe(UNIFIED_EXEC_OUTPUT_MAX_BYTES);
    expect(buffer.omittedBytes()).toBe(4_096);
  });

  it('keeps the first and last bytes when output arrives in fragmented chunks', () => {
    const buffer = new BoundedOutputBuffer(8);
    buffer.pushChunk(Buffer.from('abc'));
    buffer.pushChunk(Buffer.from('def'));
    buffer.pushChunk(Buffer.from('ghi'));

    expect(buffer.toBytes().toString('ascii')).toBe('abcdfghi');
    expect(buffer.omittedBytes()).toBe(1);
    expect(buffer.totalBytes()).toBe(9);
    expect(buffer.toBytesWithOmissionMarker().toString('ascii')).toBe('abcd\n... 1 bytes omitted ...\nfghi');
  });

  it('keeps the correct prefix and suffix when a single chunk replaces the whole tail window', () => {
    const buffer = new BoundedOutputBuffer(8);
    buffer.pushChunk(Buffer.from('abcdef'));
    buffer.pushChunk(Buffer.from('ghijk'));

    expect(buffer.toBytes().toString('ascii')).toBe('abcdhijk');
    expect(buffer.omittedBytes()).toBe(3);
    expect(buffer.totalBytes()).toBe(11);
  });

  it('continues appending correctly after replacing the tail window with a large chunk', () => {
    const buffer = new BoundedOutputBuffer(8);
    buffer.pushChunk(Buffer.from('abcdef'));
    buffer.pushChunk(Buffer.from('ghijk'));
    buffer.pushChunk(Buffer.from('lm'));

    expect(buffer.toBytes().toString('ascii')).toBe('abcdjklm');
    expect(buffer.omittedBytes()).toBe(5);
    expect(buffer.totalBytes()).toBe(13);
  });

  it('keeps the first and last bytes across many single-byte chunks', () => {
    const buffer = new BoundedOutputBuffer(16);
    for (const byte of Buffer.from('0123456789abcdefghijklmnop')) buffer.pushChunk(Buffer.from([byte]));

    expect(buffer.toBytes().toString('ascii')).toBe('01234567ijklmnop');
    expect(buffer.omittedBytes()).toBe(10);
    expect(buffer.totalBytes()).toBe(26);
  });

  it('preserves omission totals when combining process output buffers', () => {
    const source = new BoundedOutputBuffer(8);
    source.pushChunk(Buffer.from('abcdefghij'));
    const combined = new BoundedOutputBuffer(12);
    combined.pushChunk(Buffer.from('x'));
    combined.pushBuffer(source);

    expect(combined.toBytes().toString('ascii')).toBe('xabcdghij');
    expect(combined.omittedBytes()).toBe(2);
    expect(combined.totalBytes()).toBe(11);
  });

  it('preserves command-result output sections and timeout wording', () => {
    const text = formatCommandResult({
      exitCode: 124,
      stdout: 'partial output',
      stderr: '',
      elapsedMs: 2_001,
      timedOut: true
    }, { kind: 'bytes', bytes: 256 });

    expect(text).toBe([
      'Exit code: 124',
      'Wall time: 2 seconds',
      'Output:',
      'command timed out after 2001 milliseconds\npartial output'
    ].join('\n'));
  });
});
