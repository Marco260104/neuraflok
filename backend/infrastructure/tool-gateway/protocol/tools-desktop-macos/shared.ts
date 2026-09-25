import { ComputerError } from '../../../device-control/native/index.js';
import type { ToolContent } from '../kernel.js';

export const MAX_CLIPBOARD_LINE_CHARS = 16_000;
export const MAX_CLIPBOARD_OUTPUT_CHARS = 64_000;
const MAX_MCP_RESPONSE_BYTES = 8 * 1024 * 1024;
const MCP_RESPONSE_ENVELOPE_RESERVE_BYTES = 64 * 1024;

export function desktopImageResult(text: string, data: string): { content: ToolContent[] } {
  const result = {
    content: [
      { type: 'text', text } as ToolContent,
      { type: 'image', data, mimeType: 'image/png' } as ToolContent
    ]
  };
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  const limit = MAX_MCP_RESPONSE_BYTES - MCP_RESPONSE_ENVELOPE_RESERVE_BYTES;
  if (bytes > limit) {
    throw new ComputerError(
      `DESKTOP_RESULT_TOO_LARGE: combined screenshot and control metadata are ${bytes} bytes; limit ${limit}. Retry with a smaller max_width or max_elements.`
    );
  }
  return result;
}

export function prefix(note: string | null, body: string): string {
  return note ? `${note}\n\n${body}` : body;
}

export function describeWindow(window: {
  id: number;
  process: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: string;
}): string {
  return (
    `window: ${window.id}\nprocess: ${window.process}\ntitle: ${window.title}\n` +
    `bounds: ${window.x},${window.y} ${window.width}x${window.height}\nstate: ${window.state}`
  );
}
