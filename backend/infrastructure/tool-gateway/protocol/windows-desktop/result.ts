import { ComputerError } from '../../../device-control/native/index.js';
import type { ToolContent, ToolResult } from '../kernel.js';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024 - 64 * 1024;

export function desktopResult(method: string, value: unknown): ToolResult {
  const content: ToolContent[] = [];
  let metadata = value;
  if (method === 'get_window_state' && value && typeof value === 'object' && 'screenshots' in value) {
    const state = value as { screenshots: Array<{ url: string; [key: string]: unknown }> };
    metadata = { ...state, screenshots: state.screenshots.map(({ url: _url, ...shot }) => shot) };
    for (const shot of state.screenshots) {
      const match = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/.exec(shot.url);
      if (!match) throw new ComputerError('IMAGE_INVALID: native screenshot was not a PNG data URL.');
      content.push({ type: 'image', mimeType: 'image/png', data: match[1]! });
    }
  }
  // Native image blocks own pixels so screenshots do not inflate the text budget or duplicate user data.
  const normalized = metadata ?? null;
  content.unshift({ type: 'text', text: metadata === undefined ? `${method}: input accepted; observe to verify the result.` : JSON.stringify(metadata) });
  const result: ToolResult = { content, structuredContent: { value: normalized } };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESPONSE_BYTES) {
    throw new ComputerError('DESKTOP_RESULT_TOO_LARGE: this observation exceeds the combined image/metadata limit. Reobserve without text or screenshot.');
  }
  return result;
}
