import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { z } from 'zod';
import { WorkspaceTerminals } from './workspace-terminal.js';

export function registerWorkspaceTerminalIpc(getWindow: () => BrowserWindow | null): void {
  let owner: WebContents | null = null;
  let terminals: WorkspaceTerminals | null = null;
  let retirement = Promise.resolve();
  let retirementCount = 0;
  let shutdownRequested = false;
  const dispose = (expectedOwner?: WebContents): Promise<void> => {
    if (expectedOwner && owner !== expectedOwner) return retirement;
    const current = terminals;
    terminals = null;
    owner = null;
    if (current) {
      retirementCount += 1;
      retirement = retirement.then(() => current.dispose()).finally(() => { retirementCount -= 1; });
    }
    return retirement;
  };
  app.on('before-quit', event => {
    if (!terminals && retirementCount === 0) return;
    event.preventDefault();
    if (shutdownRequested) return;
    shutdownRequested = true;
    void dispose().finally(() => { shutdownRequested = false; app.quit(); });
  });
  const request = z.discriminatedUnion('action', [
    z.object({ action: z.literal('create'), id: z.string().uuid(), projectId: z.string().uuid().nullable(), cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }).strict(),
    z.object({ action: z.literal('write'), id: z.string().uuid(), data: z.string().max(65_536) }).strict(),
    z.object({ action: z.literal('resize'), id: z.string().uuid(), cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }).strict(),
    z.object({ action: z.literal('ack'), id: z.string().uuid(), count: z.number().int().min(0).max(65_536) }).strict(),
    z.object({ action: z.literal('close'), id: z.string().uuid() }).strict()
  ]);
  ipcMain.handle('workspaceTerminal:request', async (event, payload: unknown) => {
    try {
      const target = getWindow();
      if (!target || target.isDestroyed() || event.sender !== target.webContents || event.senderFrame !== target.webContents.mainFrame) throw new Error('Terminal window is unavailable');
      const args = request.parse(payload);
      if (shutdownRequested) throw new Error('The app is shutting down');
      if (owner !== event.sender) {
        await dispose(); owner = event.sender;
        const current = owner;
        terminals = new WorkspaceTerminals(value => { if (owner === current && !current.isDestroyed()) current.send('workspaceTerminal:event', value); }, app.getPath('home'));
        const retireOwner = (): void => { void dispose(current); };
        current.once('destroyed', retireOwner); current.once('did-start-loading', retireOwner);
      }
      const service = terminals!;
      const data = args.action === 'create' ? await service.create(args.id, args.projectId, args.cols, args.rows)
        : args.action === 'write' ? await service.write(args.id, args.data)
        : args.action === 'resize' ? service.resize(args.id, args.cols, args.rows)
        : args.action === 'ack' ? service.acknowledge(args.id, args.count) : service.close(args.id);
      return { ok: true, data };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  });
}
