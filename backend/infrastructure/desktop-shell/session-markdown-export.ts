import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, clipboard, dialog, type BrowserWindow } from 'electron';
import { prepareMarkdownExport, type MarkdownContentRequest } from '../../domains/sessions/history/prepare-markdown-export.js';

export type MarkdownExportRequest = MarkdownContentRequest & {
  target: 'clipboard' | 'file';
};

export type MarkdownExportResult =
  | { done: 'copied' }
  | { done: 'saved'; name: string }
  | { done: 'cancelled' };

export async function exportSessionMarkdown(request: MarkdownExportRequest, owner: BrowserWindow | null): Promise<MarkdownExportResult> {
  const prepared = await prepareMarkdownExport(request);
  if (request.target === 'clipboard') {
    clipboard.writeText(prepared.content);
    return { done: 'copied' };
  }
  const options = {
    title: 'Export as Markdown',
    defaultPath: path.join(app.getPath('downloads'), prepared.fileName),
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  };
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { done: 'cancelled' };
  await fs.writeFile(result.filePath, prepared.content, 'utf8');
  return { done: 'saved', name: path.basename(result.filePath) };
}
