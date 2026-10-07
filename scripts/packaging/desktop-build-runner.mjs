import { spawnSync } from 'node:child_process';

export function executeDesktopBuildPlan(plan, {
  root,
  environment = process.env,
  spawn = spawnSync
}) {
  for (const step of plan) {
    const result = spawn(step.command, step.args, {
      cwd: root,
      stdio: 'inherit',
      env: step.environment ?? environment
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const failure = new Error(`Packaging step ${step.name} failed.`);
      failure.exitCode = result.status ?? 1;
      throw failure;
    }
  }
}
