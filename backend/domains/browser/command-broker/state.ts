import type { Command, CommandReceipt } from './model.js';

export let commands: Command[] = [];
export let commandReceipts: CommandReceipt[] = [];
export const commandRetirementsAwaitingBroker = new Map<string, Command>();
export const commandWrites = new Map<string, Promise<boolean>>();
export const commandRedeems = new Map<string, Promise<void>>();
export const awaitingReturn = new Set<string>();

export function replaceCommands(next: Command[]): void {
  commands = next;
}

export function replaceCommandReceipts(next: CommandReceipt[]): void {
  commandReceipts = next;
}

export function resetBridgeCommandState(): void {
  commands = [];
  commandReceipts = [];
  commandRetirementsAwaitingBroker.clear();
  commandWrites.clear();
  commandRedeems.clear();
  awaitingReturn.clear();
}
