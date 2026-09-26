import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { CODE_MODE_WORKER_SOURCE } from './code-mode-worker.js';
import type { ToolContent, ToolResult } from './kernel.js';
import { CODE_MODE_LIMITS, type CodeModeOptions, type CodeModeTool } from './code-mode-contract.js';
import { validateEmittedImage } from './code-mode-images.js';
const requireRuntime = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
let activeRuns = 0;

/** A fresh interpreter per call. Accepted child operations retain their dispatcher lifetime after interpreter termination; this owner never pretends a filesystem/process action rolled back. */
export async function runCodeMode(
  code: string, tools: CodeModeTool[], invoke: (name: string, args: unknown) => Promise<ToolResult>,
  limits: { [Key in keyof typeof CODE_MODE_LIMITS]: number } = CODE_MODE_LIMITS,
  options: CodeModeOptions = {}
): Promise<ToolResult> {
  const errorResult = (reason: string): ToolResult => ({ content: [{ type: 'text', text: `CODE_MODE_${reason}` }], isError: true });
  if (!code.trim() || code.length > limits.codeChars) return errorResult('CODE_LIMIT');
  if (activeRuns >= limits.activeRuns) return errorResult('BUSY: too many code executions or unsettled nested calls.');
  // Yield/resume requires another durable lifecycle. Keep this endpoint one bounded call; ordinary exec_command/write_stdin already own long-running process continuations.
  if (/^\s*\/\/ @exec:/m.test(code)) return errorResult('UNSUPPORTED_PRAGMA: use plain JavaScript; execution is bounded to one call.');
  activeRuns++;
  const pending = new Set<Promise<void>>();
  const emissions: Array<{ kind: 'text' | 'image'; json: string }> = [];
  let worker: Worker | undefined, ended = false, calls = 0, resultBytes = 0, emittedBytes = 0;
  let textBytes = 0, images = 0, textTruncated = false;
  const allowed = new Set(tools.map(tool => tool.name));
  try {
    const status = await new Promise<string | null>(resolve => {
      const finish = (reason: string | null) => {
        if (ended) return;
        ended = true; clearTimeout(timer);
        void worker?.terminate();
        resolve(reason);
      };
      const timer = setTimeout(() => finish('TIME_LIMIT'), limits.wallMs);
      try {
        worker = new Worker(CODE_MODE_WORKER_SOURCE, { eval: true, workerData: {
          code, tools, limits, windowsDesktop: options.windowsDesktop === true, coreModule: requireRuntime.resolve('quickjs-emscripten-core'),
          wasmModule: requireRuntime.resolve('@jitl/quickjs-wasmfile-release-sync')
        }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
      } catch { finish('RUNTIME_ERROR'); return; }
      worker.on('error', () => finish('RUNTIME_ERROR'));
      worker.on('exit', code => { if (!ended) finish(code === 0 ? null : 'RUNTIME_ERROR'); });
      worker.on('message', (message: { type: string; id?: number; json?: string; kind?: string; error?: string | null }) => {
        if (ended) return;
        if (message.type === 'done') { finish(message.error ?? null); return; }
        if (typeof message.json !== 'string') { finish('BRIDGE_ERROR'); return; }
        const bytes = Buffer.byteLength(message.json);
        if (message.type === 'emit') {
          if ((message.kind !== 'text' && message.kind !== 'image') || emissions.length >= limits.outputItems ||
              bytes > limits.resultBytes || (emittedBytes += bytes) > limits.outputBytes) { finish('OUTPUT_LIMIT'); return; }
          if (message.kind === 'text') {
            let value: unknown;
            try { value = JSON.parse(message.json); } catch { finish('OUTPUT_INVALID'); return; }
            if (typeof value !== 'string') { finish('OUTPUT_INVALID'); return; }
            const buffer = Buffer.from(value, 'utf8');
            if (buffer.length > limits.textBytes - textBytes) {
              // This value was explicitly emitted. Preserve the available prefix instead of replacing a whole useful read with an opaque error; never expose intermediates.
              let end = Math.max(0, limits.textBytes - textBytes);
              while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
              if (end) emissions.push({ kind: 'text', json: JSON.stringify(buffer.subarray(0, end).toString('utf8')) });
              textTruncated = true;
              finish('OUTPUT_LIMIT'); return;
            }
            textBytes += buffer.length;
          } else if (++images > limits.images) { finish('OUTPUT_LIMIT'); return; }
          emissions.push({ kind: message.kind, json: message.json });
          return;
        }
        if (message.type !== 'call' || !Number.isSafeInteger(message.id) || calls >= limits.calls ||
            pending.size >= limits.concurrentCalls || bytes > limits.argumentBytes) { finish('CALL_LIMIT'); return; }
        const id = message.id;
        let request: { name: string; args?: unknown };
        try { request = JSON.parse(message.json); } catch { finish('BRIDGE_ERROR'); return; }
        if (!allowed.has(request.name)) { finish('UNKNOWN_TOOL'); return; }
        // Admission is synchronous. No late worker message may start another action after finish.
        calls++;
        const work = Promise.resolve().then(() => invoke(request.name, request.args)).then(result => {
          if (ended) return;
          const json = JSON.stringify(result);
          const bytes = Buffer.byteLength(json);
          if (bytes > limits.resultBytes || (resultBytes += bytes) > limits.totalResultBytes) { finish('RESULT_LIMIT'); return; }
          worker!.postMessage({ type: 'result', id, json });
        }, () => { if (!ended) worker!.postMessage({ type: 'result', id, json: JSON.stringify(errorResult('TOOL_ERROR')) }); })
          .catch(() => finish('RESULT_INVALID'));
        pending.add(work);
        void work.then(() => pending.delete(work));
      });
    });
    const content: ToolContent[] = [];
    for (const emission of emissions) {
      try {
        const value: unknown = JSON.parse(emission.json);
        if (emission.kind === 'text' && typeof value === 'string') content.push({ type: 'text', text: value });
        else if (emission.kind === 'image') content.push(await validateEmittedImage(value));
        else throw new Error('OUTPUT_INVALID');
      } catch { return { content: [...errorResult('OUTPUT_INVALID: image or text could not be validated.').content, ...content], isError: true }; }
    }
    // Status must survive head-only logs and bounded history previews, even after a full emission.
    const diagnostics: ToolContent[] = [];
    if (status) {
      const effects = calls
        ? `${calls} tool calls already dispatched; side effects were not rolled back. Inspect current state before retrying.`
        : 'No tool calls were dispatched.';
      const hint = status === 'PARSE_ERROR'
        ? ' Source could not be parsed or initialized; check quoting, closing brackets, and unsupported imports.'
        : status === 'OUTPUT_LIMIT'
          ? ` ${textTruncated ? 'Explicit text was truncated. ' : ''}Limits: ${limits.textBytes} UTF-8 text bytes, ${limits.images} images, ${limits.outputItems} output items. Filter results or read smaller ranges; use direct tools for large reads.`
          : status === 'SCRIPT_ERROR'
            ? ' Check the JavaScript and available tool names; catch an expected error and explicitly text(...) only the details you need.'
            : '';
      diagnostics.push(...errorResult(`${status}: execution stopped. ${effects}${hint} Unemitted values remain private.`).content);
    }
    if (pending.size) diagnostics.push(...errorResult('UNAWAITED_CALLS: dispatched tool calls are still running and remain recorded. Side effects were not cancelled.').content);
    return { content: [...diagnostics, ...content], ...(status || pending.size ? { isError: true } : {}) };
  } finally {
    ended = true;
    await worker?.terminate();
    // Do not allow fire-and-forget scripts to evade the global host-work bound.
    if (pending.size) void Promise.allSettled([...pending]).then(() => { activeRuns--; });
    else activeRuns--;
  }
}
