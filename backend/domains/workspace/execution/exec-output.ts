import { countLines, truncateText, type TruncationPolicy } from './output-bounds.js';

export interface CommandResultOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
}

function outputText(result: CommandResultOutput): string {
  const text = result.stdout + result.stderr;
  return result.timedOut ? `command timed out after ${Math.trunc(result.elapsedMs)} milliseconds\n${text}` : text;
}

export function formatCommandResult(result: CommandResultOutput, policy: TruncationPolicy): string {
  const text = outputText(result);
  const totalLines = countLines(text);
  const visibleText = truncateText(text, policy);
  const elapsedSeconds = Math.round((result.elapsedMs / 1000) * 10) / 10;
  const sections = [
    `Exit code: ${result.exitCode}`,
    `Wall time: ${elapsedSeconds} seconds`
  ];
  if (totalLines !== countLines(visibleText)) sections.push(`Total output lines: ${totalLines}`);
  sections.push('Output:', visibleText);
  return sections.join('\n');
}
