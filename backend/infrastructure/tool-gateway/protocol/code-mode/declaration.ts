import { codeModeSchema, type CodeModeOptions } from '../code-mode-contract.js';
import { toolDeclaration } from '../declaration-cache.js';

const STANDARD_DESCRIPTION = [
  'Run isolated JavaScript against this NEURAFLOK surface with {code}. Use only names and schemas in ALL_TOOLS, await calls, and inspect content, structuredContent, and isError. Only text(...) or image(...) reaches the model; nested calls are recorded separately.',
  'No Node, shell, filesystem, network, timers, console, imports, or persistent globals. Limits: 64k source characters, 32 MiB JS memory, 2 s CPU, 60 s wall time, 32 calls (8 concurrent), 1 MiB per argument, 12 MiB per result, 32 MiB total results, 12 MiB output, 32 items, 40,000 text bytes, and 4 images.',
  'Exact request, chat, and session identity is required unless unattributed mode is enabled. Permissions are checked per call. A dispatched action can survive script failure; inspect before retrying. Call session_finish and agents finish directly; no recursive exec, wait, or yield.'
].join(' ');

const WINDOWS_DESKTOP_DESCRIPTION = [
  'Compose NEURAFLOK Windows desktop tools with JavaScript. Use only names and schemas in ALL_TOOLS, await nested calls, and inspect content, structuredContent, and isError. Native results return directly; failures throw. get_window_state may include a screenshot. Use nodeRepl.write(...) or text(...) for text and image(...) for images. sky.target is windows.',
  'No Node, shell, filesystem, network, timers, console, imports, or persistent globals. Limits: 64k source, 32 MiB JS memory, 2 s CPU, 60 s, 32 calls (8 concurrent), 1 MiB per argument, 12 MiB per result, 32 MiB total results, 12 MiB output, 32 items, 40,000 UTF-8 text bytes, 4 images.',
  'Permissions apply per call. Missing identity requires Allow unattributed calls. Observe before acting and verify afterward. A dispatched action can continue after script failure; inspect before retrying.'
].join(' ');

export function codeModeDeclaration(options: CodeModeOptions = {}) {
  return toolDeclaration('exec', () => ({
    title: 'Run JavaScript',
    description: options.windowsDesktop ? WINDOWS_DESKTOP_DESCRIPTION : STANDARD_DESCRIPTION,
    inputSchema: codeModeSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }), options.windowsDesktop ? 'windows-desktop' : 'standard');
}
