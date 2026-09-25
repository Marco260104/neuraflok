import { redactCredentialText } from '../../../infrastructure/settings/redaction.js';

type RedactableObject = Record<string, unknown>;

const REDACTED_FILE = '<native file credentials not stored>';
const REDACTED_CLIPBOARD = '<clipboard text not stored>';

function isObjectValue(value: unknown): value is RedactableObject {
  return value !== null && typeof value === 'object';
}

function hideEnvironmentValues(value: RedactableObject): RedactableObject {
  return Object.fromEntries(Object.keys(value).map(key => [key, '***']));
}

function hideComputerClipboardActions(value: unknown[]): unknown[] {
  return value.map(action => {
    if (!isObjectValue(action) || action.type !== 'write_clipboard' || typeof action.text !== 'string') return action;
    return { ...action, text: `<${action.text.length} characters not stored>` };
  });
}

function redactArgumentField(tool: string, field: string, value: unknown): unknown {
  if (field === 'secret') return '<removed>';
  if (tool === 'download_artifact' && field === 'file') return REDACTED_FILE;
  if (field === 'env' && value && isObjectValue(value)) return hideEnvironmentValues(value);
  if (field === 'dataBase64' && typeof value === 'string') return `<${value.length} base64 characters not stored>`;
  if (tool === 'write_clipboard' && field === 'text' && typeof value === 'string') {
    return `<${value.length} characters not stored>`;
  }
  if (tool === 'computer' && field === 'actions' && Array.isArray(value)) {
    return hideComputerClipboardActions(value);
  }
  return value;
}

export function redactArgs(tool: string, args: unknown): unknown {
  if (!isObjectValue(args)) return args;
  const safe: RedactableObject = { ...args };
  for (const field of Object.keys(safe)) safe[field] = redactArgumentField(tool, field, safe[field]);
  return safe;
}

function hideComputerClipboardOutput(text: string): string {
  return text.split('\n').map(line => {
    if (!line.startsWith('Clipboard read ')) return line;
    const delimiter = line.indexOf(':');
    return `${line.slice(0, delimiter + 1)} ${REDACTED_CLIPBOARD}`;
  }).join('\n');
}

export function redactResult(tool: string, text: string): string {
  const safeText = redactCredentialText(text);
  if (tool === 'read_clipboard') return REDACTED_CLIPBOARD;
  if (tool === 'computer' && safeText.includes('Clipboard read ')) return hideComputerClipboardOutput(safeText);
  return safeText;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 0) ?? 'null';
  } catch {
    return '"<arguments could not be serialised>"';
  }
}
