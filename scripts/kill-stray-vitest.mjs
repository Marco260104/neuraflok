import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const runFile = promisify(execFile);
const vitestCommand = /(?:^|[\\/\s])vitest(?:\.cmd|\.mjs|\.js)?(?:[\\/\s]|$)/i;

async function inspectWindowsProcesses() {
  const query = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    encoding: 'utf8',
    windowsHide: true
  });
  const payload = stdout.trim();
  const processes = payload ? JSON.parse(payload) : [];
  return (Array.isArray(processes) ? processes : [processes]).map((process) => ({
    pid: Number(process.ProcessId),
    executable: 'node.exe',
    command: String(process.CommandLine ?? '')
  }));
}

async function inspectUnixProcesses() {
  const { stdout } = await runFile('ps', ['-A', '-o', 'pid=', '-o', 'comm=', '-o', 'args='], { encoding: 'utf8' });
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), executable: match[2], command: match[3] }];
  });
}

async function findVictims() {
  const inspect = process.platform === 'win32' ? inspectWindowsProcesses : inspectUnixProcesses;
  return selectVitestProcesses(await inspect());
}

export function selectVitestProcesses(processes, currentPid = process.pid) {
  const seen = new Set();
  return processes.filter(({ pid, executable, command }) => {
    const isNode = /^(?:node(?:\.exe)?|nodejs)$/i.test(executable);
    const isCandidate = isNode && Number.isSafeInteger(pid) && pid > 0 && pid !== currentPid && vitestCommand.test(command);
    if (!isCandidate || seen.has(pid)) return false;
    seen.add(pid);
    return true;
  });
}

export function stopProcesses(processes, terminate = process.kill) {
  let stopped = 0;
  for (const { pid } of processes) {
    try {
      terminate(pid, 'SIGKILL');
      stopped += 1;
    } catch {}
  }
  return stopped;
}

async function main() {
  try {
    const victims = await findVictims();
    if (victims.length === 0) {
      console.log('no stray vitest processes');
    } else {
      const stopped = stopProcesses(victims);
      console.log(`killed ${stopped} stray vitest process(es)`);
    }
  } catch (error) {
    console.error(`could not inspect Vitest processes: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main();
