import { readRendererMarkup } from '../scripts/read-renderer-markup.cjs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = process.cwd();

describe('runtime multi-agent enable regression', () => {
  it('wires persistence before unconditional restore and preserves history while disabled', async () => {
    const source = await readFile(path.join(repo, 'backend/application/startup.ts'), 'utf8');
    const persistSink = source.indexOf('onSwarmPersistNow((snapshot) => writeDurableNow(SWARM_STATE, snapshot))');
    const restoreRead = source.indexOf('const savedSwarm = await readDurable<SwarmSnapshot>(SWARM_STATE)');
    const shutdownFence = source.indexOf('if (windowActivation.isDisabled()) return;', restoreRead);
    const restore = source.indexOf('restoreSwarm(savedSwarm)', restoreRead);
    const disabledPause = source.indexOf("pauseSwarmForDisable('multi-agent mode is disabled')");

    expect(persistSink).toBeGreaterThanOrEqual(0);
    expect(restoreRead).toBeGreaterThanOrEqual(0);
    expect(shutdownFence).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(disabledPause).toBeGreaterThanOrEqual(0);
    expect(persistSink).toBeLessThan(restoreRead);
    expect(restoreRead).toBeLessThan(shutdownFence);
    expect(shutdownFence).toBeLessThan(restore);
    expect(restore).toBeLessThan(disabledPause);
    expect(source).not.toContain('await writeDurableNow(SWARM_STATE, null)');
  });
});

describe('NEURAFLOK integrated browser contract', () => {
  it('uses the bundled companion without a manual extension installation flow', async () => {
    const ipcDirectory = path.join(repo, 'backend/application/ipc');
    const ipc = (await Promise.all((await readdir(ipcDirectory)).filter(file => file.endsWith('.ts')).map(file => readFile(path.join(ipcDirectory, file), 'utf8')))).join('\n');
    const [html, renderer, chat, preload] = await Promise.all([
      readRendererMarkup(repo),
      readFile(path.join(repo, 'frontend/main.ts'), 'utf8'),
      readFile(path.join(repo, 'frontend/features/chat/chat.ts'), 'utf8'),
      readFile(path.join(repo, 'backend/preload/index.ts'), 'utf8')
    ]);

    expect(html).toContain('NEURAFLOK loads and updates this component automatically.');
    expect(html).not.toContain('chrome://extensions');
    expect(html).not.toContain('Load unpacked');
    expect(html).not.toContain('id="browserExtensionStage"');
    expect(html).not.toContain('/releases/latest/');
    expect(ipc).not.toContain('/releases/latest/');
    expect(renderer).not.toContain('api.downloadExtension()');
    expect(preload).not.toContain("call<boolean>('bridge:downloadExtension')");
    expect(ipc).not.toContain("handle('bridge:downloadExtension'");
    expect(preload).not.toContain('bridge:openExtensionFolder');
    expect(ipc).not.toContain("handle('bridge:openExtensionFolder'");
    expect(chat).not.toContain('openExtensionFolder');
  });
});
