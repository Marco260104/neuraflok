import {
  approxTokenCount,
  byteLength,
  formattedTruncateText,
  policyTokenBudget,
  truncateText,
  type TruncationPolicy
} from './output-bounds.js';
import { formatOutputOmissionMarker, resolveMaxTokens } from './unified-exec-constants.js';
import type { ProcessCompletion } from './unified-exec-process.js';

export interface ExecCommandToolOutput {
  completedSessionId?: number;
  replayed?: boolean;
  benignExit?: boolean;
  completion?: Promise<ProcessCompletion>;
  chunkId: string;
  wallTimeMs: number;
  rawOutput: Buffer;
  displayOutput?: Buffer;
  truncationPolicy: TruncationPolicy;
  maxOutputTokens: number | undefined;
  processId: number | null;
  exitCode: number | null;
  originalTokenCount: number | null;
  outputOmittedBytes: number | null;
}

export interface ExecCommandProjection {
  text: string;
  structured: Record<string, unknown>;
  output: string;
}

function modelOutputMaxTokens(output: ExecCommandToolOutput): number {
  return Math.min(resolveMaxTokens(output.maxOutputTokens), policyTokenBudget(output.truncationPolicy));
}

export function truncatedOutput(output: ExecCommandToolOutput, maxTokens: number): string {
  const text = (output.displayOutput ?? output.rawOutput).toString('utf8');
  const policy: TruncationPolicy = { kind: 'tokens', tokens: maxTokens };
  if (output.outputOmittedBytes === null || output.outputOmittedBytes === 0) {
    return formattedTruncateText(text, policy);
  }

  const marker = formatOutputOmissionMarker(output.outputOmittedBytes);
  if (byteLength(text) <= maxTokens * 4) {
    return text.includes(marker) ? text : `${marker}\n${text}`;
  }

  const originalTokenCount = output.originalTokenCount ?? approxTokenCount(text);
  const truncated = truncateText(text, policy);
  const omissionNotice = truncated.includes(marker) ? '' : `${marker}\n`;
  return `Warning: truncated output (original token count: ${originalTokenCount})\n${omissionNotice}\n${truncated}`;
}

export function execCommandResponseText(output: ExecCommandToolOutput): string {
  return projectExecCommandOutput(output).text;
}

export function execCommandStructuredOutput(output: ExecCommandToolOutput): Record<string, unknown> {
  return projectExecCommandOutput(output).structured;
}

export function projectExecCommandOutput(output: ExecCommandToolOutput): ExecCommandProjection {
  const boundedOutput = truncatedOutput(output, modelOutputMaxTokens(output));
  const sections: string[] = [];
  if (output.chunkId !== '') sections.push(`Chunk ID: ${output.chunkId}`);
  sections.push(`Wall time: ${(output.wallTimeMs / 1000).toFixed(4)} seconds`);
  if (output.exitCode !== null) sections.push(`Process exited with code ${output.exitCode}`);
  if (output.processId !== null) sections.push(`Process running with session ID ${output.processId}`);
  if (output.completedSessionId !== undefined) sections.push(`Completed session ID: ${output.completedSessionId}`);
  if (output.replayed) sections.push('Retained output (already completed; command was not run again):');
  if (output.benignExit) sections.push('This non-zero exit is an expected command result, not a failure.');
  if (output.originalTokenCount !== null) sections.push(`Original token count: ${output.originalTokenCount}`);
  sections.push('Output:');
  sections.push(boundedOutput);
  const structured: Record<string, unknown> = {
    ...(output.chunkId === '' ? {} : { chunk_id: output.chunkId }),
    wall_time_seconds: output.wallTimeMs / 1000,
    ...(output.exitCode === null ? {} : { exit_code: output.exitCode }),
    ...(output.processId === null ? {} : { session_id: output.processId }),
    ...(output.completedSessionId === undefined ? {} : { completed_session_id: output.completedSessionId }),
    ...(output.benignExit ? { benign_exit: true } : {}),
    ...(output.replayed ? { output_replayed: true } : {}),
    ...(output.originalTokenCount === null ? {} : { original_token_count: output.originalTokenCount }),
    output: boundedOutput
  };
  return { text: sections.join('\n'), structured, output: boundedOutput };
}
