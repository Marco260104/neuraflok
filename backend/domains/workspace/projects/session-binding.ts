import { bindSessionProject, findSessionByConversation } from '../../sessions/history/store.js';
import { getProject } from './catalog.js';
import { resolveProjectWorkspace } from './workspace.js';

export async function assignSessionProject(sessionId: string, projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  await resolveProjectWorkspace(project);
  await bindSessionProject(sessionId, project.id);
}

export async function inheritSessionProject(sessionId: string, primeConversationId: string): Promise<void> {
  const prime = await findSessionByConversation(primeConversationId, { requireUnique: true });
  if (prime?.conversationId !== primeConversationId || !prime.projectId) return;
  await assignSessionProject(sessionId, prime.projectId);
}
