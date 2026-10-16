import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), workspace: vi.fn(), command: true,
  exitHandlers: new Set<(event: { exitCode: number }) => void>(),
  pty: { onData: vi.fn(), onExit: vi.fn(), pause: vi.fn(), resume: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() }
}));
vi.mock('node-pty', () => ({ spawn: mocks.spawn }));
vi.mock('../backend/domains/workspace/projects.js', () => ({ projectWorkspace: mocks.workspace }));
vi.mock('../backend/infrastructure/settings/config.js', () => ({ getConfig: () => ({}), effectiveCapabilities: () => ({ command: mocks.command }) }));
vi.mock('../backend/domains/workspace/execution/shell.js', () => ({ defaultUserShell: () => ({ shellPath: 'shell', shellType: 'bash' }) }));
import { WorkspaceTerminals } from '../backend/domains/workspace/workspace-terminal.js';
beforeEach(() => {
  vi.clearAllMocks(); mocks.exitHandlers.clear(); mocks.command = true;
  mocks.spawn.mockReturnValue(mocks.pty); mocks.workspace.mockResolvedValue({ real: '/project' });
  mocks.pty.onExit.mockImplementation(handler => { mocks.exitHandlers.add(handler); return { dispose: () => mocks.exitHandlers.delete(handler) }; });
  mocks.pty.kill.mockImplementation(() => {
    const handler = mocks.exitHandlers.values().next().value;
    if (handler) { mocks.exitHandlers.delete(handler); handler({ exitCode: 0 }); }
  });
});

it('captures project cwd and cancels a pending spawn when its tab closes', async () => {
  let resolve!: (value: { real: string }) => void;
  mocks.workspace.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const service = new WorkspaceTerminals(vi.fn(), '/home');
  const opening = service.create('one', 'project-a', 80, 24); service.close('one');
  resolve({ real: '/project' }); await expect(opening).rejects.toThrow('cancelled'); expect(mocks.spawn).not.toHaveBeenCalled();
  await expect(service.create('two', 'project-a', 80, 24)).resolves.toMatchObject({ cwd: '/project' });
  expect(mocks.spawn).toHaveBeenCalledWith('shell', [], expect.objectContaining({ cwd: '/project', cols: 80, rows: 24 }));
  await service.dispose(); expect(mocks.pty.kill).toHaveBeenCalledOnce();
});
it('rechecks command permission and original project identity before interactive input', async () => {
  const service = new WorkspaceTerminals(vi.fn(), '/home'); await service.create('one', 'project-a', 80, 24);
  mocks.command = false; await expect(service.write('one', 'rm file\r')).rejects.toThrow('disabled');
  mocks.command = true; mocks.workspace.mockResolvedValue({ real: '/other' });
  await expect(service.write('one', 'pwd\r')).rejects.toThrow('changed'); expect(mocks.pty.write).not.toHaveBeenCalled();
  await service.dispose();
});
it('pauses output until xterm has parsed it and releases exited or disposed terminals', async () => {
  const emit = vi.fn(), service = new WorkspaceTerminals(emit, '/home'); await service.create('one', 'project-a', 80, 24);
  const data = mocks.pty.onData.mock.calls[0]![0]; data('a'.repeat(262_144));
  expect(emit).toHaveBeenCalledTimes(16); expect(mocks.pty.pause).toHaveBeenCalledOnce();
  service.acknowledge('one', 262_144); expect(mocks.pty.resume).toHaveBeenCalledOnce();
  mocks.pty.onExit.mock.calls[0]![0]({ exitCode: 7 }); expect(emit).toHaveBeenLastCalledWith({ id: 'one', exitCode: 7 });
  await expect(service.write('one', 'echo x')).rejects.toThrow('closed');
  await service.dispose(); expect(mocks.pty.kill).not.toHaveBeenCalled();
});
it('bounds active plus pending tabs and prevents spawn after renderer retirement', async () => {
  const service = new WorkspaceTerminals(vi.fn(), '/home');
  for (let index = 0; index < 8; index++) await service.create(String(index), 'project-a', 80, 24);
  await expect(service.create('ninth', 'project-a', 80, 24)).rejects.toThrow('maximum 8');
  await service.dispose(); expect(mocks.pty.kill).toHaveBeenCalledTimes(8);
});
it('starts projectless shells in the main-owned home cwd without resolving a project', async () => {
  const service = new WorkspaceTerminals(vi.fn(), '/home');
  await expect(service.create('one', null, 80, 24)).resolves.toMatchObject({ projectId: null, cwd: '/home' });
  expect(mocks.workspace).not.toHaveBeenCalled();
  expect(mocks.spawn).toHaveBeenCalledWith('shell', [], expect.objectContaining({ cwd: '/home' }));
  await service.write('one', 'pwd\r');
  expect(mocks.workspace).not.toHaveBeenCalled();
  expect(mocks.pty.write).toHaveBeenCalledWith('pwd\r');
  mocks.command = false;
  await expect(service.write('one', 'echo denied\r')).rejects.toThrow('disabled');
  await service.dispose();
});

it('waits for shells already closed by their tabs before completing shutdown', async () => {
  const service = new WorkspaceTerminals(vi.fn(), '/home');
  await service.create('one', null, 80, 24);
  const onExit = mocks.pty.onExit.mock.calls[0]![0];
  mocks.pty.kill.mockImplementation(() => {});
  service.close('one');
  let settled = false;
  const disposal = service.dispose().then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  onExit({ exitCode: 0 });
  await disposal;
  expect(settled).toBe(true);
  await expect(service.create('two', null, 80, 24)).rejects.toThrow('stopping');
});
it('never falls back to home when a selected project cannot be resolved', async () => {
  mocks.workspace.mockRejectedValueOnce(new Error('Project is unavailable'));
  const service = new WorkspaceTerminals(vi.fn(), '/home');
  await expect(service.create('one', 'missing-project', 80, 24)).rejects.toThrow('Project is unavailable');
  expect(mocks.spawn).not.toHaveBeenCalled();
});
