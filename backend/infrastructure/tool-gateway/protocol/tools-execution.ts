import { registerExecCommandTool } from './tools-execution/command.js';
import { registerWriteStdinTool } from './tools-execution/write-stdin.js';
import type { SurfaceRegistrar } from './kernel.js';

export function registerExecutionTools(reg: SurfaceRegistrar): void {
  if (!reg.exposedCaps.command) return;
  registerExecCommandTool(reg);
  registerWriteStdinTool(reg);
}
