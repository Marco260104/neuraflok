import type http from 'node:http';
import type { Config } from '../../../contracts/types.js';
import type { Command } from './command-broker/model.js';
import type { PreparedBridge } from './bridge-listener.js';
import type { RetiredChat, WorkerSpawn, WorkerRevival } from '../automation/agents.js';

type Runtime = {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  get epoch(): number;
  get desiredRunning(): boolean;
  get shutdownRequested(): boolean;
  isCurrent(epoch: number): boolean;
  setDesiredRunning(value: boolean): void;
  getServer(): http.Server | null;
  setServer(server: http.Server | null): void;
  getPort(): number | null;
  setPort(port: number | null): void;
  isRecovering(): boolean;
  setRecovering(value: boolean): void;
  setError(value: string | null): void;
  getCommands(): readonly Command[];
  getConfig(): Config;
  selectPorts(value?: Config['ui']['browserBridgePort']): { candidates: readonly number[]; overridden: boolean };
  prepareListener(candidates: readonly number[], epoch: number): Promise<PreparedBridge>;
  closeCancelledStart(instance: http.Server, actual?: number | null): Promise<null>;
  drainListener(instance: http.Server): Promise<void>;
  attachWake(instance: http.Server): void;
  disposeWake(): void;
  resetBrowserControl(): void;
  clearPresence(): void;
  clearDiagnostics(): void;
  deliver(): void;
  changed(): void;
  logInfo(message: string): void;
  logWarn(message: string): void;
  restoreCommands(): Promise<void>;
  rearmRetainedCommandDeadlines(): void;
  onSwarmChange(listener: () => void): () => void;
  retireInactiveWorkerRecovery(): void;
  isLocalAgentDeliveryActive(): boolean;
  onSpawnRequest(listener: (workers: WorkerSpawn[]) => void): () => void;
  onReviveRequest(listener: (revivals: WorkerRevival[]) => void): () => void;
  onSwarmEnd(listener: (reason: string, retired: RetiredChat[], runId: string) => void): () => void;
  queueWorkerBootstrap(worker: WorkerSpawn): void;
  queueWorkerRevival(revival: WorkerRevival): void;
  cancelWorkerCommands(reason: string, runId: string): void;
  sweepStaleSwarm(): Promise<boolean>;
  retryUnclaimedBrowserInputs(): Promise<void>;
  installCallAttributionListener(): void;
  removeCallAttributionListener(): void;
  setServingWatchFloors(now: number): void;
  clearSilenceTimer(): void;
  clearUnattributedIncident(): void;
};

export function createBridgeServerLifecycle(runtime: Runtime) {
  let dropSwarmEndListener: (() => void) | null = null;
  let dropSwarmChangeListener: (() => void) | null = null;
  let dropSpawnRequestListener: (() => void) | null = null;
  let dropReviveRequestListener: (() => void) | null = null;
  let staleSwarmTimer: NodeJS.Timeout | null = null;
  let staleSweepInFlight: Promise<boolean> | null = null;
  const bridgeDrains = new Set<Promise<void>>();

  function runStaleSwarmSweep(): Promise<boolean> {
    if (staleSweepInFlight) return staleSweepInFlight;
    staleSweepInFlight = runtime.sweepStaleSwarm().finally(() => {
      staleSweepInFlight = null;
    });
    return staleSweepInFlight;
  }

  async function startBridgeOnce(epoch: number, prepared?: PreparedBridge): Promise<number | null> {
    runtime.setRecovering(true);
    try {
      prepared ??= await runtime.prepareListener(runtime.selectPorts(runtime.getConfig().ui.browserBridgePort).candidates, epoch);
    } catch (error) {
      runtime.setRecovering(false);
      if (runtime.isCurrent(epoch) && !runtime.shutdownRequested) {
        const message = error instanceof Error ? error.message : String(error);
        runtime.setError(message);
        runtime.logWarn(message);
        runtime.changed();
      }
      return null;
    }
    const { instance, actual } = prepared;
    if (!runtime.isCurrent(epoch)) return runtime.closeCancelledStart(instance, actual);
    runtime.setServer(instance);
    runtime.setPort(actual);
    try {
      await runtime.restoreCommands();
    } catch (error) {
      if (runtime.getServer() === instance) runtime.setServer(null);
      if (runtime.getPort() === actual) runtime.setPort(null);
      runtime.setRecovering(false);
      await new Promise<void>(resolve => instance.close(() => resolve()));
      runtime.logWarn(`bridge startup recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (!runtime.isCurrent(epoch)) return runtime.closeCancelledStart(instance, actual);
    runtime.rearmRetainedCommandDeadlines();
    dropSwarmChangeListener?.();
    dropSwarmChangeListener = runtime.onSwarmChange(runtime.retireInactiveWorkerRecovery);
    runtime.retireInactiveWorkerRecovery();
    if (!runtime.isLocalAgentDeliveryActive()) {
      dropSpawnRequestListener?.();
      dropSpawnRequestListener = runtime.onSpawnRequest(workers => {
        for (const worker of workers) runtime.queueWorkerBootstrap(worker);
      });
      dropReviveRequestListener?.();
      dropReviveRequestListener = runtime.onReviveRequest(revivals => {
        for (const revival of revivals) runtime.queueWorkerRevival(revival);
      });
    }
    dropSwarmEndListener?.();
    dropSwarmEndListener = runtime.onSwarmEnd((reason, _retired, runId) => {
      runtime.cancelWorkerCommands(reason, runId);
    });
    if (staleSwarmTimer) clearInterval(staleSwarmTimer);
    staleSwarmTimer = setInterval(() => {
      void runStaleSwarmSweep().catch((error: Error) => runtime.logWarn(`stale swarm sweep failed: ${error.message}`));
      void runtime.retryUnclaimedBrowserInputs().catch((error: Error) => runtime.logWarn(`unclaimed browser input recovery failed: ${error.message}`));
    }, 30_000);
    staleSwarmTimer.unref?.();
    void runtime.retryUnclaimedBrowserInputs().catch((error: Error) => runtime.logWarn(`unclaimed browser input recovery failed: ${error.message}`));
    runtime.installCallAttributionListener();
    runtime.setServingWatchFloors(Date.now());
    runtime.setRecovering(false);
    runtime.attachWake(instance);
    runtime.setError(null);
    runtime.deliver();
    runtime.logInfo(`bridge listening on 127.0.0.1:${actual}`);
    runtime.changed();
    return actual;
  }

  async function stopActiveBridge(): Promise<void> {
    const instance = runtime.getServer();
    if (!instance) {
      await Promise.all(bridgeDrains);
      return;
    }
    runtime.disposeWake();
    runtime.resetBrowserControl();
    runtime.setServer(null);
    runtime.setPort(null);
    runtime.clearPresence();
    runtime.clearDiagnostics();
    for (const command of runtime.getCommands()) {
      if (command.timer) clearTimeout(command.timer);
      command.timer = null;
    }
    dropSwarmEndListener?.();
    dropSwarmEndListener = null;
    dropSwarmChangeListener?.();
    dropSwarmChangeListener = null;
    dropSpawnRequestListener?.();
    dropSpawnRequestListener = null;
    dropReviveRequestListener?.();
    dropReviveRequestListener = null;
    if (staleSwarmTimer) clearInterval(staleSwarmTimer);
    staleSwarmTimer = null;
    runtime.clearSilenceTimer();
    runtime.removeCallAttributionListener();
    runtime.clearUnattributedIncident();
    await Promise.all([runtime.drainListener(instance), ...bridgeDrains]);
    runtime.logInfo('bridge stopped');
    runtime.changed();
  }

  function publishBridgePortChange(next: Config, previous: Config, persist: () => Promise<Config>): Promise<Config> {
    if ((next.ui.browserBridgePort ?? 'auto') === (previous.ui.browserBridgePort ?? 'auto')) return persist();
    const selection = runtime.selectPorts(next.ui.browserBridgePort);
    if (selection.overridden) return Promise.reject(new Error('Browser bridge port is controlled by NEURAFLOK_BRIDGE_PORTS.'));
    return runtime.enqueue(async () => {
      if (runtime.shutdownRequested) throw new Error('Browser bridge is shutting down.');
      const epoch = runtime.epoch;
      const prepared = await runtime.prepareListener(selection.candidates, epoch);
      let published = false;
      try {
        if (!runtime.isCurrent(epoch) || runtime.shutdownRequested) throw new Error('Browser bridge change cancelled.');
        const config = await persist();
        if (!runtime.isCurrent(epoch) || runtime.shutdownRequested) return config;
        const old = runtime.getServer();
        if (prepared.instance === old) {
          published = true;
          return config;
        }
        if (!old) {
          runtime.setDesiredRunning(true);
          await startBridgeOnce(epoch, prepared);
          published = runtime.getServer() === prepared.instance;
          return config;
        }
        runtime.disposeWake();
        runtime.resetBrowserControl();
        runtime.clearPresence();
        runtime.clearDiagnostics();
        runtime.setServer(prepared.instance);
        runtime.setPort(prepared.actual);
        runtime.setError(null);
        runtime.attachWake(prepared.instance);
        published = true;
        const drain = runtime.drainListener(old);
        bridgeDrains.add(drain);
        void drain.finally(() => bridgeDrains.delete(drain));
        runtime.deliver();
        runtime.changed();
        runtime.logInfo(`bridge listening on 127.0.0.1:${prepared.actual}`);
        return config;
      } finally {
        if (!published && prepared.instance !== runtime.getServer()) await runtime.drainListener(prepared.instance);
      }
    });
  }

  return { publishBridgePortChange, runStaleSwarmSweep, startBridgeOnce, stopActiveBridge };
}
