import type { InputAttachment } from '../../../../contracts/input.js';
import { readProviderTextAttachment } from './attachments/index.js';
import { prepareProviderSessionPrompt, prepareProviderSkillFollowup } from './prompt.js';
import type { InputEntry } from './input.js';

/** Leave room for the web adapter's transport guide inside its own message ceiling. */
export const LOCAL_PROVIDER_PROMPT_LIMITS = { maxChars: 72_000, maxBytes: 288_000 } as const;
export const WEB_BOOTSTRAP_ACK = 'NEURAFLOK_READY';
export const LEGACY_WEB_BOOTSTRAP_ACK = 'NEURAL_JAM_READY';
const WEB_BOOTSTRAP_REQUEST = `Initialize this NEURAFLOK conversation using the instructions below. This is configuration only, not a user task. Do not run tools or execute examples. Reply with exactly ${WEB_BOOTSTRAP_ACK} and wait for the next user message.`;
const MAX_INLINE_ATTACHMENT_BYTES = 500_000;

/** Setup is its own first native message; authored work and file bytes arrive afterwards. */
export async function prepareWebProviderBootstrap(entry: InputEntry, sessionId: string, guide: string): Promise<string> {
  const setup = await prepareProviderSessionPrompt(WEB_BOOTSTRAP_REQUEST,
    { sessionId, projectId: entry.projectId }, LOCAL_PROVIDER_PROMPT_LIMITS, '');
  return `${setup}\n\n${guide}\n\n${WEB_BOOTSTRAP_REQUEST}`;
}

async function attachedText(attachments: readonly InputAttachment[] | undefined, allowImages: boolean): Promise<string> {
  if (!attachments?.length) return '';
  const sections: string[] = [];
  let bytes = 0;
  for (const attachment of attachments) {
    if (attachment.mimeType.startsWith('image/')) {
      if (!allowImages) throw new Error(`“${attachment.name}” is an image. Image attachments are supported by the API executor; use a project file with a web session.`);
      sections.push(`[Image attachment: ${attachment.name}. Image data is sent separately.]`);
      continue;
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

/** Prepare the exact text that a local executor sends. Opening turns use NEURAFLOK's provider tool guide plus the selected project's AGENTS.md and frozen Skills; later turns add only explicitly selected Skills. File bytes are read from the validated attachment store and bounded first. */
export async function prepareLocalProviderPrompt(
  entry: InputEntry, sessionId: string, opening: boolean, options: { allowImageAttachments?: boolean } = {}
): Promise<string> {
  const scope = { sessionId, projectId: entry.projectId, autoSkills: entry.autoSkills };
  const base = opening
    ? await prepareProviderSessionPrompt(entry.text, scope, LOCAL_PROVIDER_PROMPT_LIMITS, entry.text)
    : await prepareProviderSkillFollowup(entry.text, entry.text, LOCAL_PROVIDER_PROMPT_LIMITS, scope);
  const files = await attachedText(entry.attachments, options.allowImageAttachments === true);
  const prepared = `${base}${files}`;
  if (prepared.length > LOCAL_PROVIDER_PROMPT_LIMITS.maxChars || Buffer.byteLength(prepared, 'utf8') > LOCAL_PROVIDER_PROMPT_LIMITS.maxBytes) {
    throw new Error('The message and attached files exceed the local provider context limit. Shorten the message or add the folder as a project.');
  }
  return prepared;
}
