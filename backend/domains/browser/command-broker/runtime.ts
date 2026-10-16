import { createBridgeCommandLedger, type BridgeCommandLedgerRuntime } from './ledger.js';
import { createBridgeCommandDeadlines, type BridgeCommandDeadlineRuntime } from './deadlines.js';
import { createBridgeCommandLifecycle, type BridgeCommandLifecycleRuntime } from './lifecycle.js';
import { createBridgeCommandProjection, type BridgeCommandProjectionRuntime } from './projection.js';

type DeadlineDependencies = Omit<BridgeCommandDeadlineRuntime, 'finalizeCommand' | 'persistCommands'>;
type LifecycleDependencies = Omit<
  BridgeCommandLifecycleRuntime,
  | 'commandDeadlineDelay'
  | 'commandExpiryReason'
  | 'commandSnapshot'
  | 'persistCommands'
  | 'revivalDeadlineAt'
  | 'retire'
  | 'scheduleDeliver'
  | 'writeCommandTransition'
>;
type ProjectionDependencies = Omit<BridgeCommandProjectionRuntime, 'commandDeadlineDelay'>;

function extendRuntime<T extends object, E extends object>(runtime: T, extensions: E): T & E {
  return Object.assign(Object.create(runtime) as T, extensions);
}

export interface BridgeCommandRuntimeOptions {
  ledger: BridgeCommandLedgerRuntime;
  deadlines: DeadlineDependencies;
  lifecycle: LifecycleDependencies;
  projection: ProjectionDependencies;
}

export function createBridgeCommandRuntime(options: BridgeCommandRuntimeOptions) {
  const ledger = createBridgeCommandLedger(options.ledger);
  const deadlines = createBridgeCommandDeadlines(
    extendRuntime(options.deadlines, {
      finalizeCommand: ledger.finalizeCommand,
      persistCommands: ledger.persistCommands
    })
  );
  const lifecycle = createBridgeCommandLifecycle(
    extendRuntime(options.lifecycle, {
      commandDeadlineDelay: deadlines.commandDeadlineDelay,
      commandExpiryReason: deadlines.commandExpiryReason,
      commandSnapshot: ledger.commandSnapshot,
      persistCommands: ledger.persistCommands,
      revivalDeadlineAt: deadlines.revivalDeadlineAt,
      retire: deadlines.retire,
      scheduleDeliver: deadlines.scheduleDeliver,
      writeCommandTransition: ledger.writeCommandTransition
    })
  );
  const projection = createBridgeCommandProjection(
    extendRuntime(options.projection, { commandDeadlineDelay: deadlines.commandDeadlineDelay })
  );

  return { ledger, deadlines, lifecycle, projection };
}
