import { afterEach, expect, it } from 'vitest';
import { CommandBatchDisplay, parseCommandBatchSections } from '../backend/domains/workspace/execution/command-batch.js';
import { UnifiedExecProcessManager, execCommandResponseText, execCommandStructuredOutput } from '../backend/domains/workspace/execution/unified-exec.js';

const marker = '0123456789abcdef01234567';
const commandFrame = `__NEURAFLOK_BATCH_V1_${marker}_C1_1__`;
const exitFrame = `__NEURAFLOK_BATCH_V1_${marker}_E7__`;
const wire = `${commandFrame}\r\n--- exit code 0 ---\nreal error\n${exitFrame}\r\n`;
const visible = `--- command 1/1 ---\r\n--- exit code 0 ---\nreal error\n--- exit code 7 ---\r\n`;
const managers: UnifiedExecProcessManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.terminateAllProcesses(); });

it('removes only the invocation delimiter across every byte boundary, preserving output and fake exit lines', () => {
  for (let split = 0; split <= wire.length; split++) {
    const display = new CommandBatchDisplay(marker);
    expect(Buffer.concat([display.push(Buffer.from(wire.slice(0, split))), display.push(Buffer.from(wire.slice(split)), true)]).toString()).toBe(visible);
  }
  const display = new CommandBatchDisplay(marker);
  expect(Buffer.concat([...Buffer.from(wire)].map((byte) => display.push(Buffer.from([byte]))).concat(display.push(Buffer.alloc(0), true))).toString()).toBe(visible);
  expect(parseCommandBatchSections(wire, marker)).toEqual([{ index: 1, exitCode: 7, text: '--- exit code 0 ---\nreal error' }]);
  expect(parseCommandBatchSections(wire, 'f'.repeat(24))).toEqual([]);
});

it('stops parsing when complete batch sections arrive out of order', () => {
  const output = [
    `__NEURAFLOK_BATCH_V1_${marker}_C1_3__`,
    'first',
    `__NEURAFLOK_BATCH_V1_${marker}_E0__`,
    `__NEURAFLOK_BATCH_V1_${marker}_C3_3__`,
    'third',
    `__NEURAFLOK_BATCH_V1_${marker}_E0__`,
    `__NEURAFLOK_BATCH_V1_${marker}_C2_3__`,
    'second',
    `__NEURAFLOK_BATCH_V1_${marker}_E0__`
  ].join('\n');

  expect(parseCommandBatchSections(output, marker)).toEqual([
    { index: 1, exitCode: 0, text: 'first' }
  ]);
});

it('keeps different markers, ordinary Unicode bytes, and an incomplete delimiter at stream close', () => {
  const input = `hello 日本語 🦉 __NEURAFLOK_BATCH_V1_${'f'.repeat(24)}_C1_1__\n __NEURAFLOK_BATCH_V1_${marker}_C`;
  const display = new CommandBatchDisplay(marker);
  expect(Buffer.concat([...Buffer.from(input)].map((byte) => display.push(Buffer.from([byte]))).concat(display.push(Buffer.alloc(0), true))).toString()).toBe(input);
});

async function start(script: string) {
  const manager = new UnifiedExecProcessManager(5_000);
  managers.push(manager);
  const output = await manager.execCommand({ command: [process.execPath, '-e', script], batchMarker: marker,
    shellType: process.platform === 'win32' ? 'powershell' : 'bash', hookCommand: 'batch presentation fixture',
    processId: manager.allocateProcessId(), yieldTimeMs: 250, maxOutputTokens: undefined,
    truncationPolicy: { kind: 'tokens', tokens: 100 }, cwd: process.cwd(), displayCwd: process.cwd(), env: process.env, tty: false });
  return { manager, output };
}

it('keeps framing internal before retention and token truncation in both result representations', async () => {
  const { output } = await start(`process.stdout.write(${JSON.stringify(wire)}); process.stdout.write('x'.repeat(2_200_000)); process.stdout.write(${JSON.stringify(wire)});`);
  expect(output.rawOutput.toString()).toContain('NEURAFLOK_BATCH_V1_');
  expect(output.displayOutput?.toString()).not.toContain('NEURAFLOK_BATCH_V1_');
  expect(output.outputOmittedBytes).toBeGreaterThan(0);
  const text = execCommandResponseText(output);
  const structured = execCommandStructuredOutput(output);
  expect(text).toContain(structured.output);
  expect(text).not.toContain(marker);
  expect(structured.output).not.toContain('NEURAFLOK_BATCH_V1_');
});

it('projects a delimiter split between initial output and a later stdin poll exactly once', async () => {
  const first = commandFrame.slice(0, 15);
  const rest = `${commandFrame.slice(15)}\nhello\n${exitFrame}\n`;
  const { manager, output } = await start(`process.stdout.write(${JSON.stringify(first)}); setTimeout(() => { process.stdout.write(${JSON.stringify(rest)}); process.exitCode = 7; }, 900);`);
  expect(output.processId).not.toBeNull();
  const displays = [String(execCommandStructuredOutput(output).output)];
  let current = output;
  while (current.processId !== null) {
    current = await manager.writeStdin({ processId: current.processId, input: '', yieldTimeMs: 1_000, maxOutputTokens: undefined, truncationPolicy: { kind: 'tokens', tokens: 100 } });
    expect(execCommandResponseText(current)).toContain(execCommandStructuredOutput(current).output);
    displays.push(String(execCommandStructuredOutput(current).output));
  }
  expect(displays.join('')).toBe('--- command 1/1 ---\nhello\n--- exit code 7 ---\n');
  expect(current.exitCode).toBe(7);
});
