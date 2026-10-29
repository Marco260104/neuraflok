import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import type { InputEntry } from '../backend/domains/sessions/input/input.js';
import { composerInputMode, waitForPendingOpeningSession } from '../frontend/features/chat/chat-composer-delivery.js';

it('queues every user delivery behind the required project preparation', () => {
  expect(composerInputMode('auto', true, false)).toBe('after-turn');
  expect(composerInputMode('tool', true, false)).toBe('after-turn');
  expect(composerInputMode('finish', true, true)).toBe('after-turn');
  expect(composerInputMode('auto', false, false)).toBe('auto');
  expect(composerInputMode('after-turn', false, true)).toBe('finish');
});

it('keeps the composer usable and shows preparation outside its input surface', async () => {
  const html = await readFile(new URL('../frontend/shell/views/chat.html', import.meta.url), 'utf8');
  const controls = await readFile(new URL('../frontend/features/chat/chat-delivery-controls.ts', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../frontend/styles/chat/shell-and-composer.css', import.meta.url), 'utf8');
  const workspaceStyles = await readFile(new URL('../frontend/styles/neuraflok/workspace-skin.css', import.meta.url), 'utf8');

  expect(html).not.toContain('composerReadyGate');
  expect(html).toContain('placeholder="Ask anything…"');
  expect(styles).not.toContain('composer-ready-gate');
  expect(controls).toContain('send.disabled = planDisabled;');
  expect(workspaceStyles).toMatch(/\.workspace-empty-title\s*\{\s*font-size:\s*calc\(15px \* var\(--text-scale, 1\)\);/);
  expect(workspaceStyles).toContain('font-size: calc(14px * var(--text-scale, 1));');
});

it('waits for a new chat session to be adopted before delivering a second message', async () => {
  const openingId = 'opening-session';
  const accepted = { id: openingId, opening: true } as InputEntry;
  let selectedId: string | null = null;
  let selectionGeneration = 4;
  let pendingNewInput: { id: string; generation: number } | null = { id: openingId, generation: selectionGeneration };
  const runtime = {
    api: { listInputs: vi.fn(async () => ({ ok: true, data: [accepted] })) },
    get pendingNewInput() { return pendingNewInput; },
    get selectionGeneration() { return selectionGeneration; },
    get selectedId() { return selectedId; },
    adoptAcceptedOpening: vi.fn(async (entry: InputEntry) => {
      if (entry.id !== openingId) return false;
      selectedId = openingId;
      selectionGeneration++;
      pendingNewInput = null;
      return true;
    })
  } as unknown as Parameters<typeof waitForPendingOpeningSession>[0];

  await expect(waitForPendingOpeningSession(runtime)).resolves.toBe(true);
  expect(selectedId).toBe(openingId);
  expect(runtime.adoptAcceptedOpening).toHaveBeenCalledWith(accepted);
});
