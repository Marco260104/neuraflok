export const WORKER_BRIDGE_SOURCE = String.raw`
  const bridge = vm.newFunction('__bridge', (operation, payload) => {
    const kind = vm.getString(operation), json = vm.getString(payload);
    if (fatal) return { error: vm.newError('Script limit reached') };
    if (kind === 'exit') { finish(null); return vm.undefined; }
    if (closed) return { error: vm.newError('Script closed') };
    if (kind === 'call') {
      if (++nextId > workerData.limits.calls || pending.size >= workerData.limits.concurrentCalls || Buffer.byteLength(json) > workerData.limits.argumentBytes) {
        fatal = 'CALL_LIMIT'; return { error: vm.newError('Call limit') };
      }
      const promise = vm.newPromise();
      pending.set(nextId, promise);
      send({ type: 'call', id: nextId, json });
      return promise.handle.dup();
    }
    if (kind === 'text' || kind === 'image') {
      const size = Buffer.byteLength(json);
      outputBytes += size;
      if (++emitted > workerData.limits.outputItems || size > workerData.limits.resultBytes || outputBytes > workerData.limits.outputBytes) {
        fatal = 'OUTPUT_LIMIT'; return { error: vm.newError('Output limit') };
      }
      send({ type: 'emit', kind, json });
      return vm.undefined;
    }
    fatal = 'BRIDGE_ERROR'; return { error: vm.newError('Invalid bridge operation') };
  });
  vm.setProp(vm.global, '__bridge', bridge); bridge.dispose();
`;
