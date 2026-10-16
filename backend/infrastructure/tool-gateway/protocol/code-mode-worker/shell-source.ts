export const WORKER_SHELL_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { newQuickJSWASMModuleFromVariant } = require(workerData.coreModule);
const variant = require(workerData.wasmModule).default;
let closed = false;
const send = message => { if (!closed) parentPort.postMessage(message); };
function finish(error) { if (closed) return; send({ type: 'done', error }); closed = true; }
(async () => {
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(workerData.limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const vm = runtime.newContext();
  let usedCpu = 0, sliceStart = 0, fatal = null, nextId = 0, emitted = 0, outputBytes = 0;
  const pending = new Map();
  runtime.setInterruptHandler(() => usedCpu + performance.now() - sliceStart > workerData.limits.cpuMs);
  const enter = fn => { sliceStart = performance.now(); try { return fn(); } finally { usedCpu += performance.now() - sliceStart; } };
`;
