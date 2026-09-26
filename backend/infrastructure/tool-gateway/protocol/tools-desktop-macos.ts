import type { SurfaceRegistrar } from './kernel.js';
import { registerMacOSComputerTool } from './tools-desktop-macos/computer.js';
import { registerMacOSObserveTool } from './tools-desktop-macos/observe.js';

/** Register the macOS tool surface through its observation and action owners. */
export function registerMacOSDesktopTools(reg: SurfaceRegistrar): void {
  registerMacOSObserveTool(reg);
  registerMacOSComputerTool(reg);
}