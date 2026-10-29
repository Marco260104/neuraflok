import type { InputAttachment } from '../../../../contracts/input.js';
import path from 'node:path';
import { isProviderOfficeDocument, isSupportedProviderImage } from '../../../../contracts/attachments.js';
import { readProviderTextAttachment } from './attachments/index.js';
import { prepareProviderSessionPrompt } from './prompt.js';
import type { InputEntry } from './input.js';

/** Leave room for the web adapter's transport guide inside its own message ceiling. */
export const LOCAL_PROVIDER_PROMPT_LIMITS = { maxChars: 72_000, maxBytes: 288_000 } as const;
export const WEB_BOOTSTRAP_ACK = 'NEURAFLOK_READY';
export const LEGACY_WEB_BOOTSTRAP_ACK = 'NEURAL_JAM_READY';
export const WEB_CONTEXT_CHECK_MARKER = 'NEURAFLOK_CONTEXT_CHECK';
const WEB_BOOTSTRAP_REQUEST = `Initialize this NEURAFLOK conversation using the instructions below. This is configuration only, not a user task. Do not run tools or execute examples. Reply with exactly ${WEB_BOOTSTRAP_ACK} and wait for the next user message.`;
const MAX_INLINE_ATTACHMENT_BYTES = 500_000;

export interface WebContextCheck {
  prompt: string;
  expectedWords: string[];
}

function contextWords(text: string): string[] {
  return text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Ask the provider to prove it can still read the last authored request in an existing chat. */
export function prepareWebProviderContextCheck(previousRequest: string | null): WebContextCheck {
  const words = previousRequest ? contextWords(previousRequest) : [];
  const expectedWords = words.slice(-Math.min(8, words.length));
  const proof = expectedWords.length
    ? `On the second line, copy the final ${expectedWords.length} words of the most recent human-authored task from before this application-generated readiness check, exactly and without quotation marks. Ignore earlier setup and readiness messages. Do not copy words from this instruction; find the task in the earlier conversation. If you cannot see it, reply exactly CONTEXT_MISSING.`
    : 'If you can read this conversation and its project instructions, reply exactly NEURAFLOK_READY. If you cannot, reply exactly CONTEXT_MISSING.';
  return {
    prompt: `${WEB_CONTEXT_CHECK_MARKER}\nThis is a hidden readiness check for the existing NEURAFLOK chat. Do not answer earlier tasks, summarize, or use tools. On the first line reply exactly ${WEB_BOOTSTRAP_ACK}. ${proof}`,
    expectedWords
  };
}

/** A provider is ready only when it returns the acknowledgement and the requested history proof. */
export function confirmsWebProviderContext(text: string, expectedWords: readonly string[]): boolean {
  const lines = String(text ?? '').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== WEB_BOOTSTRAP_ACK) return false;
  if (!expectedWords.length) return lines.length === 1;
  const answer = contextWords(lines.slice(1).join(' '));
  if (answer.length < expectedWords.length) return false;
  const start = answer.findIndex((_, index) => expectedWords.every((word, offset) => answer[index + offset] === word));
  return start >= 0;
}

/** Setup is its own first native message; authored work and file bytes arrive afterwards. */
export async function prepareWebProviderBootstrap(entry: InputEntry, sessionId: string, guide: string): Promise<string> {
  const setup = await prepareProviderSessionPrompt(WEB_BOOTSTRAP_REQUEST,
    { sessionId, projectId: entry.projectId }, LOCAL_PROVIDER_PROMPT_LIMITS, '');
  return `${setup}\n\n${guide}\n\n${WEB_BOOTSTRAP_REQUEST}`;
}

async function attachedText(attachments: readonly InputAttachment[] | undefined, allowImages: boolean, allowPdfs: boolean, allowOfficeDocuments: boolean): Promise<string> {
  if (!attachments?.length) return '';
  const sections: string[] = [];
  let bytes = 0;
  for (const attachment of attachments) {
    if (isSupportedProviderImage(attachment.mimeType)) {
      if (!allowImages) throw new Error(`“${attachment.name}” is an image. Image attachments are supported by the API executor; use a project file with a web session.`);
      sections.push(`[Image attachment: ${attachment.name}. Image data is sent separately.]`);
      continue;
    }
    const isPdf = attachment.mimeType === 'application/pdf' || path.extname(attachment.name).toLowerCase() === '.pdf';
    if (isPdf && allowPdfs) {
      sections.push(`[PDF attachment: ${attachment.name}. The original PDF is uploaded with this message, including its page images.]`);
      continue;
    }
    if (isProviderOfficeDocument(attachment.name)) {
      if (!allowOfficeDocuments) throw new Error(`“${attachment.name}” must be attached to a DeepSeek Web chat or added to a project folder.`);
      sections.push(`[Office document attachment: ${attachment.name}. The original file is uploaded with this message.]`);
      continue;
    }
    if (attachment.mimeType.startsWith('image/')) {
      throw new Error(`“${attachment.name}” uses an image format that DeepSeek does not accept.`);
    }
    const remaining = MAX_INLINE_ATTACHMENT_BYTES - bytes;
    if (remaining < 1) throw new Error('Attached text files exceed the 500 KB inline context limit. Add their folder as a project instead.');
    const text = await readProviderTextAttachment(attachment, remaining);
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_INLINE_ATTACHMENT_BYTES) throw new Error('Attached text files exceed the 500 KB inline context limit. Add their folder as a project instead.');
    sections.push(`<ATTACHED_FILE name=${JSON.stringify(attachment.name)}>\n${text}\n</ATTACHED_FILE>`);
  }
  return `\n\n<USER_ATTACHED_FILES>\n${sections.join('\n\n')}\n</USER_ATTACHED_FILES>`;
}

/** Prepare the exact text that a local executor sends. Opening turns use the provider tool guide plus the selected project's AGENTS.md and frozen Skills; later turns keep language and project directory and add only explicitly selected Skills. File bytes are read from the validated attachment store and bounded first. */
export async function prepareLocalProviderPrompt(
  entry: InputEntry, sessionId: string, options: {
    allowImageAttachments?: boolean;
    allowPdfAttachments?: boolean;
    allowOfficeAttachments?: boolean;
    historySummary?: string;
    projectPlanPhase?: 'draft';
    projectPlanContext?: string;
  } = {}
): Promise<string> {
  const scope = {
    sessionId,
    projectId: entry.projectId,
    autoSkills: entry.autoSkills,
    historySummary: options.historySummary,
    projectPlanPhase: options.projectPlanPhase ?? entry.projectPlanPhase,
    projectPlanContext: options.projectPlanContext
  };
  const base = await prepareProviderSessionPrompt(entry.text, scope, LOCAL_PROVIDER_PROMPT_LIMITS, entry.text);
  const files = await attachedText(entry.attachments, options.allowImageAttachments === true,
    options.allowPdfAttachments === true, options.allowOfficeAttachments === true);
  const prepared = `${base}${files}`;
  if (prepared.length > LOCAL_PROVIDER_PROMPT_LIMITS.maxChars || Buffer.byteLength(prepared, 'utf8') > LOCAL_PROVIDER_PROMPT_LIMITS.maxBytes) {
    throw new Error('The message and attached files exceed the local provider context limit. Shorten the message or add the folder as a project.');
  }
  return prepared;
}
