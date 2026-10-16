import type { ChatInitializationBindings, ChatRendererDependencies } from './chat.js';
import { initializeChatControllers } from './chat-initialization-controllers.js';
import { initializeChatWorkspace } from './chat-initialization-workspace.js';
import { bindChatRendererEvents } from './chat-initialization-events.js';

export function initializeChatRenderer(bindings: ChatInitializationBindings, next: ChatRendererDependencies): void {
  bindings.deps = next;
  initializeChatControllers(bindings);
  initializeChatWorkspace(bindings);
  bindChatRendererEvents(bindings);
}