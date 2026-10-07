import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

try {
  execFileSync('git', ['-C', repositoryRoot, 'config', '--local', 'core.hooksPath', '.githooks'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
} catch (cause) {
  const stderr = cause instanceof Error && 'stderr' in cause ? String(cause.stderr).trim() : '';
  throw new Error(`Unable to install repository Git hooks${stderr ? `: ${stderr}` : ''}`, { cause });
}

console.log(`Configured local Git hooks for ${repositoryRoot}.`);
