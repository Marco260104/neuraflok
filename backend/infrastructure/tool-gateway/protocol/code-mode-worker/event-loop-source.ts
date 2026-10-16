export const WORKER_EVENT_LOOP_SOURCE = String.raw`
  let execution;
  const check = () => {
    if (closed) return;
    if (fatal) { finish(fatal); return; }
    if (usedCpu > workerData.limits.cpuMs) { finish('CPU_LIMIT'); return; }
    const jobs = enter(() => runtime.executePendingJobs(64));
    if (jobs.error) { jobs.error.dispose(); finish(usedCpu > workerData.limits.cpuMs ? 'CPU_LIMIT' : 'SCRIPT_ERROR'); return; }
    const state = enter(() => vm.getPromiseState(execution));
    if (state.type === 'rejected') { state.error.dispose(); finish(fatal || (usedCpu > workerData.limits.cpuMs ? 'CPU_LIMIT' : 'SCRIPT_ERROR')); return; }
    if (state.type === 'fulfilled') { state.value.dispose(); finish(fatal); return; }
    if (runtime.hasPendingJob()) setImmediate(check);
  };
  parentPort.on('message', message => {
    if (closed || message.type !== 'result') return;
    const promise = pending.get(message.id);
    if (!promise) return;
    pending.delete(message.id);
    enter(() => {
      const value = vm.newString(message.json);
      promise.resolve(value); value.dispose(); promise.dispose();
    });
    check();
  });
  const evaluated = enter(() => vm.evalCode(workerData.code, 'code-mode.mjs', { type: 'module' }));
  if (evaluated.error) { evaluated.error.dispose(); finish(fatal || (usedCpu > workerData.limits.cpuMs ? 'CPU_LIMIT' : 'PARSE_ERROR')); return; }
  execution = evaluated.value;
  check();
})().catch(() => finish('RUNTIME_ERROR'));
`;
