import { expect, it } from 'vitest';
import { projectComposerControlVisibility } from '../frontend/features/chat/chat-task-controls.js';

it('keeps project access and Plan controls out of normal chats', () => {
  expect(projectComposerControlVisibility(false)).toEqual({ accessPicker: false, planButton: false });
  expect(projectComposerControlVisibility(true)).toEqual({ accessPicker: true, planButton: true });
});
