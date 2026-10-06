import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDesktopBuildOptions } from './desktop-build-options.mjs';
import { createDesktopBuildPlan } from './desktop-build-plan.mjs';
import { executeDesktopBuildPlan } from './desktop-build-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const options = parseDesktopBuildOptions();
const plan = createDesktopBuildPlan({
  nodeExecutable: process.execPath,
  ...options
});

try {
  executeDesktopBuildPlan(plan, { root });
} catch (error) {
  if (Number.isInteger(error?.exitCode)) process.exitCode = error.exitCode;
  else throw error;
}
