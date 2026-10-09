import { vi } from 'vitest';

vi.mock('../frontend/features/workspace/terminal/composition.js', () => ({ createWorkspaceTerminal: () => ({
  update: vi.fn(), show: vi.fn(), hide: vi.fn(), newTab: vi.fn(() => null),
  tabs: vi.fn(() => []), selectTab: vi.fn(), closeTab: vi.fn()
}) }));

import './renderer-state/context.js';
import './renderer-state/worker-settings-and-state.test.js';
import './renderer-state/projects-and-chat-actions.test.js';
import './renderer-state/provider-navigation-and-search.test.js';
import './renderer-state/attachments-and-custom-models.test.js';
import './renderer-state/browser-command-and-permissions.test.js';
import './renderer-state/setup-and-roots.test.js';
import './renderer-state/provider-status-and-updates.test.js';
import './renderer-state/credentials-and-prompt-settings.test.js';
import './renderer-state/model-catalogue-and-new-chat.test.js';
