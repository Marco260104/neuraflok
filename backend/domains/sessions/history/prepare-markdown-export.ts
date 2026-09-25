import { providerForConversationId, WEB_PROVIDERS } from '../../../../contracts/web-providers.js';
import type { SessionSummary, StoredText } from '../../../../contracts/session.js';
import {
  answerMarkdown, completedTurnIds, markdownFileName, sessionMarkdown, transcriptEntries, turnAnswerEntries
} from '../../../../contracts/markdown-export.js';
import { getSession, readEvents, readOverflowText } from './store.js';

export type MarkdownContentRequest = {
  id: string;
  scope: 'answer' | 'session';
  turnId?: string;
};

export type PreparedMarkdownExport = {
  content: string;
  fileName: string;
};

async function resolveFullMessage(sessionId: string, stored: StoredText): Promise<string> {
  if (!stored.truncated || !stored.assetId) return stored.text;
  return (await readOverflowText(sessionId, stored.assetId)) ?? stored.text;
}

function resolveAssistantName(summary: SessionSummary): string {
  const webProvider = summary.conversationId ? providerForConversationId(summary.conversationId) : null;
  if (webProvider) return WEB_PROVIDERS[webProvider].label;
  const model = summary.selectedModel;
  if (!model || model.conversationId !== summary.conversationId) return 'Assistant';
  switch (model.apiProvider?.kind) {
    case 'openai': return 'OpenAI API';
    case 'openrouter': return 'OpenRouter';
    case 'custom': return 'Assistant';
    default: return 'Assistant';
  }
}

export async function prepareMarkdownExport(request: MarkdownContentRequest): Promise<PreparedMarkdownExport> {
  const summary = await getSession(request.id);
  if (!summary) throw new Error('Session not found');
  const events = await readEvents(request.id);
  if (request.scope === 'answer') {
    if (!request.turnId || !completedTurnIds(events).has(request.turnId)) throw new Error('This turn has not completed');
    const answer = turnAnswerEntries(events, request.turnId);
    if (answer.length === 0) throw new Error('This turn has no answer to export');
    return {
      content: answerMarkdown(await Promise.all(answer.map(entry => resolveFullMessage(request.id, entry.stored)))),
      fileName: markdownFileName(summary.title, ' - answer')
    };
  }
  const transcript = transcriptEntries(events);
  const entries = await Promise.all(transcript.map(async entry => ({
    role: entry.role,
    text: await resolveFullMessage(request.id, entry.stored)
  })));
  return {
    content: sessionMarkdown(summary.title, entries, { user: 'You', assistant: resolveAssistantName(summary) }),
    fileName: markdownFileName(summary.title)
  };
}
