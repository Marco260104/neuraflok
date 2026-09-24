export const MAX_HANDOFF_PROMPT_CHARS = 20_000;

export const DEFAULT_HANDOFF_PROMPT = `Create a NEURAFLOK continuation brief that lets a later session resume this work with the least repeated discovery.

Rules:
- Follow the user's explicit instructions and final decisions. Preserve the original objective, material requirements, later corrections, constraints, and preferences. If a decision changed, record the final choice and the correction.
- Keep information that affects the next action, including unfinished requirements, blockers, risks, and agreed direction. Remove repetition only when it adds no distinct meaning.
- Separate verified repository or runtime facts from plans, expectations, and claims. A stated intention is not proof that a change happened; use the observed workspace, command, and test evidence.
- Keep exact identifiers needed to continue: file paths, symbols, versions, commands, errors, ports, hashes, and relevant data formats. Do not replace precise values with vague summaries.
- Preserve the cause of important changes: observed failure, likely cause, correction, and verification. Keep known-working and known-failing behavior distinct.
- Report completed work only with its evidence. Include failures and what was already tried so the next session can choose a useful next step.
- Describe delegated or background work only when it affects continuation; state its owner and observed status. Do not present planned work as completed.
- Include workspace, branch, process, installation, or release details only when the conversation or tools establish them. If the record is incomplete or unclear, say so without guessing.
- Keep sensitive values out of the brief. Summarize tool results instead of copying large raw arguments or outputs.
- End with concrete next actions in priority order and note work that must not be repeated or undone.
- For a detailed brief, target roughly 10,000–30,000 tokens when the recorded work warrants it; a brief shorter than 6,000 tokens may omit important history. Never exceed 30,000 tokens.

Use these sections when they contain useful information; omit empty sections:

TASK — the user's objective in their terms.
USER DECISIONS — requirements, corrections, constraints, and preferences that still apply.
CURRENT STATE — what is true now and where the work stands.
DONE AND VERIFIED — completed changes with their evidence.
IN PROGRESS — started work and the exact point reached.
NEXT STEPS — concrete actions for the next session.
OPEN ISSUES — unresolved bugs, questions, and external blockers.
FILES AND CHANGES — important paths and the reason each changed.
CHECKS AND EVIDENCE — commands, tests, builds, and their results.
RUNTIME CONTEXT — relevant versions, running processes, and release state.
DO NOT REPEAT — completed or failed attempts that should not be repeated.`;

export const HANDOFF_LENGTHS = ['thorough', 'standard', 'short'] as const;
export type HandoffLength = (typeof HANDOFF_LENGTHS)[number];
export const DEFAULT_HANDOFF_LENGTH: HandoffLength = 'thorough';

const DEFAULT_LENGTH_RULE = '- For a detailed brief, target roughly 10,000–30,000 tokens when the recorded work warrants it; a brief shorter than 6,000 tokens may omit important history. Never exceed 30,000 tokens.';
const SHORTER: Record<Exclude<HandoffLength, 'thorough'>, { range: string; max: string }> = {
  standard: { range: '4,000–10,000', max: '10,000' },
  short: { range: '2,000–6,000', max: '6,000' }
};

export function handoffPromptForLength(prompt: string, length: HandoffLength = DEFAULT_HANDOFF_LENGTH): string {
  if (length === 'thorough' || !SHORTER[length]) return prompt;
  const { range, max } = SHORTER[length];
  const rule = `- For a detailed brief, target roughly ${range} tokens when the recorded work warrants it; never exceed ${max} tokens.`;
  const adapted = prompt.replace(DEFAULT_LENGTH_RULE, rule);
  return `${adapted}\n\nLength setting: target roughly ${range} tokens and never exceed ${max} tokens. This replaces any other length target in these instructions.`;
}
