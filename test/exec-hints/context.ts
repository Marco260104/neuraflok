export const BOUND_RG = "& 'C:\\tools\\rg.exe'";

export const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export const WORKER_2_SYMBOL_SWEEP =
  "echo '--- connection diff ---'; git diff -- backend/infrastructure/connectivity/connection.ts; " +
  "echo '--- connection/ipc/preload/renderer symbols ---'; " +
  'rg -n "connection:|connectBtn|connect-button|connecting|disconnect|applySettings|' +
  'saveSettings|onState|state === \'starting|state === \\"starting" ' +
  'backend/application/ipc/register.ts backend/preload/index.ts frontend/main.ts';

export const WORKER_2_IMPORT_SWEEP =
  'rg -n "from \'../backend/infrastructure/connectivity/connection|from \\"../backend/infrastructure/connectivity/connection|' +
  'connection\\.js\'|connection\\.js\\"" test . | Select-Object -First 200';
