import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function createProcessSupervisor() {
  const children = new Set();

  function launchJsonProcess(executable, args = []) {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, args, {
      env: environment,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    children.add(child);
    child.once('exit', () => children.delete(child));

    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    child.stderr.on('data', chunk => process.stderr.write(chunk));

    async function readJsonLine() {
      let timer;
      try {
        const result = await Promise.race([
          (async () => {
            let next;
            do { next = await lines.next(); } while (!next.done && !next.value.trim());
            return next;
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Desktop smoke response timeout')), 10_000);
          })
        ]);
        if (result.done) throw new Error('Desktop smoke process exited before sending a reply');
        return JSON.parse(result.value);
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      child,
      read: readJsonLine,
      request: async value => {
        child.stdin.write(`${value}\n`);
        return readJsonLine();
      }
    };
  }

  async function runFile(executable, args, options = {}) {
    const environment = { ...process.env, ...(options.env ?? {}) };
    delete environment.ELECTRON_RUN_AS_NODE;
    return execute(executable, args, {
      env: environment,
      windowsHide: true,
      timeout: options.timeout ?? 15_000,
      maxBuffer: options.maxBuffer ?? 32_768
    });
  }

  async function stopAll() {
    const activeChildren = [...children];
    for (const child of activeChildren) {
      if (!child.stdin.destroyed) child.stdin.end();
    }
    for (const child of activeChildren) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await Promise.race([
        once(child, 'exit'),
        new Promise(resolve => setTimeout(resolve, 2_000))
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }

  return { launchJsonProcess, runFile, stopAll };
}
