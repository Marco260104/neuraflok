export { workspaceKey, currentWorkspace, setWorkspaceFor, setCurrentWorkspace, primeWorkspace, workspaceForChat, moveChatWorkspace, forgetMissingWorkspace, clearChatWorkspace, resetWorkspaces, renameWorkspaceRoot, forgetWorkspaceRoot, workspaceEntries } from './registry.js';
export { inheritWorkspace, releasePrimeWorkspace, parkAgentWorkspace, bindAgentWorkspace, activateAgentWorkspace } from './agent-bindings.js';
export { projectFolderOf, learnWorkspace } from './project-discovery.js';
export type { Workspace } from './registry.js';
