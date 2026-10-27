import path from 'node:path';
import { readFileStream } from '../../workspace/execution/filesystem.js';
import { effectiveCapabilities, getConfig } from '../../../infrastructure/settings/config.js';
import { currentCoreInstructions } from '../../../infrastructure/tool-gateway/protocol/instructions.js';
import { getSessionProject, projectWorkspace } from '../../workspace/projects.js';
import { getSession } from '../history/store.js';
import { buildProjectContextTree } from '../../workspace/projects/context-tree.js';
import { resolvePath } from '../../../infrastructure/settings/sandbox.js';
import { MAX_PROVIDER_MESSAGE_CHARS, prependUserPrompt, userPromptText } from '../../../../contracts/messaging/provider-message-envelope.js';
import { replyLanguageInstruction } from '../../../../contracts/ui-language.js';
import { selectedSkillInstructions, type SelectedSkill } from './skill-prompt.js';
import { listSkillLibrary } from '../../skills/skill-library.js';
import type { RoutedSkillSelection } from '../../../../contracts/skill-routing.js';

type PromptScope = { sessionId?: string | null; projectId?: string | null; autoSkills?: readonly RoutedSkillSelection[]; historySummary?: string; projectPlanPhase?: 'draft'; projectPlanContext?: string };
export type PromptLimits = { maxChars: number; maxBytes: number };
type ProjectInstructions = { directory: string; text: string; truncated: boolean; tree?: string };
const limits: PromptLimits = { maxChars: MAX_PROVIDER_MESSAGE_CHARS, maxBytes: Infinity };
const cutNotice = '\n\n[Cut off because of the message limit. Read AGENTS.md yourself for the remaining instructions.]';
function localProviderInstructions(project: boolean): string {
  const conversational = [
    'You are a conversational assistant.',
    'Answer the user naturally and directly. Use the current message and relevant conversation history only. Do not inspect files, mention paths, run commands, or invent tool activity.'
  ];
  const workspace = [
    'You are an assistant working with the user in their selected project.',
    'Follow the current request, the selected project instructions, and any selected Skills below. Preserve existing work and keep project changes within approved folders.',
    'Use only the capabilities listed in the workspace tool guide for this conversation. A tool result is the evidence for an action: do not claim that a file changed or a command succeeded without a successful result.',
    'If a permission or required piece of context is missing, explain the limit clearly instead of guessing.'
  ];
  return [...(project ? workspace : conversational), replyLanguageInstruction(getConfig().ui.language)].join('\n\n');
}

const promptFolder = (scope: PromptScope) => scope.sessionId ? getSessionProject(scope.sessionId)
  : scope.projectId ? projectWorkspace(scope.projectId) : Promise.resolve(null);

/** One selected folder, never cwd inference, global discovery or a recursive document scan. */
async function projectInstructions(scope: PromptScope): Promise<ProjectInstructions | null> {
  if (!scope.sessionId && !scope.projectId) return null;
  // Existing sessions own their project; a caller-provided project cannot replace that binding.
  const session = scope.sessionId ? await getSession(scope.sessionId) : null;
  const projectId = scope.sessionId ? session?.projectId ?? null : scope.projectId ?? null;
  const folder = scope.sessionId ? await getSessionProject(scope.sessionId)
    : await projectWorkspace(scope.projectId!);
  if (!folder) return null;
  const canRead = effectiveCapabilities(getConfig()).read;
  let text = '';
  let truncated = false;
  if (canRead) {
    const filename = path.join(folder.real, 'AGENTS.md');
    try {
      const resolved = await resolvePath(getConfig().roots, filename, { allowMissing: true });
      // At most four UTF-8 bytes per available UTF-16 code unit, plus one byte to detect overflow. Stream a bounded prefix so even a gigabyte AGENTS.md never becomes a gigabyte allocation.
      const budget = MAX_PROVIDER_MESSAGE_CHARS * 4;
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of readFileStream(resolved.real)) {
        const kept = chunk.subarray(0, Math.max(0, budget + 1 - bytes));
        chunks.push(kept);
        bytes += kept.length;
        if (bytes > budget) break;
      }
      const data = Buffer.concat(chunks);
      // Streaming decode leaves an incomplete final codepoint out of a shortened prefix.
      text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, budget), { stream: bytes > budget });
      if (text.includes('\0')) throw new Error('AGENTS.md must be a UTF-8 text file');
      const checked = await resolvePath(getConfig().roots, filename);
      if (checked.real !== resolved.real || !effectiveCapabilities(getConfig()).read)
        throw new Error('Project instructions changed location or permission while being read');
      truncated = bytes > budget;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Do not expose native filesystem paths through the browser bridge's error response.
        throw new Error('Could not read the selected folder\'s AGENTS.md safely');
      }
    }
  }

  let tree: string | undefined;
  if (canRead && projectId) {
    try { tree = await buildProjectContextTree(projectId); }
    catch { throw new Error('Could not prepare the selected project file tree safely. No message was sent.'); }
  }
  // Permission, project ownership, or path changes during asynchronous reads cannot publish stale context.
  const current = scope.sessionId ? await getSessionProject(scope.sessionId) : await projectWorkspace(scope.projectId!);
  const latest = scope.sessionId ? await getSession(scope.sessionId) : null;
  if (!current || current.real !== folder.real || (scope.sessionId && latest?.projectId !== projectId) ||
      (canRead && !effectiveCapabilities(getConfig()).read)) {
    throw new Error('The selected project changed while its context was being prepared. No message was sent.');
  }
  return { directory: current.virtual, text: text.trim() ? text : '', truncated, ...(tree ? { tree } : {}) };
}

type PromptFrame = (text: string, instructions: string) => string;

function frameProviderPrompt(text: string, instructions: string): string {
  const authored = userPromptText(text) ?? text.replace(/\r\n?/g, '\n');
  instructions = instructions.replace(/\r\n?/g, '\n');
  return instructions.trim()
    ? `<ASSISTANT_INSTRUCTIONS>\n${instructions}\n</ASSISTANT_INSTRUCTIONS>\n\nUSER MESSAGE:\n${authored}`
    : authored;
}

/** Preserve required context; reduce AGENTS to 5k before sharing remaining space across Skills. */
function fitPrompt(text: string, core: string, agents: ProjectInstructions | null, budget: PromptLimits, skills: SelectedSkill[], frame: PromptFrame, contextSections: string[] = []): string {
  const fits = (value: string): boolean => value.length <= Math.min(MAX_PROVIDER_MESSAGE_CHARS, budget.maxChars) &&
    Buffer.byteLength(value, 'utf8') <= budget.maxBytes;
  const projectHeader = agents ? `Selected project directory: ${agents.directory}\nUse this directory as your default working directory and keep task work there unless the user or task requires another approved location. For exec_command, set workdir to ${agents.directory} and use relative paths in cmd. Never put ${agents.directory} inside cmd. This project association grants no additional filesystem permissions.` : '';
  const mandatory = [core, projectHeader].filter(Boolean).join('\n\n');
  const base = frame(text, mandatory);
  if (!fits(base)) throw new Error('The message and main instructions exceed the delivery limit (maximum 96,000 characters). Shorten the message or standing instructions.');
  const content = agents?.text.replace(/\r\n?/g, '\n') ?? '';
  const prefix = (value: string, length: number): string => {
    if (length > 0 && length < value.length && /[\uD800-\uDBFF]/.test(value[length - 1]!)) length--;
    return value.slice(0, length);
  };
  const render = (length: number, skillCap = Infinity): string => {
    const sections: string[] = [];
    if (agents?.tree) sections.push(agents.tree);
    sections.push(...contextSections.filter(Boolean));
    sections.push(...skills.map(skill => {
      const body = prefix(skill.text, skillCap);
      const filename = skill.path ?? `/skills/${skill.id}/SKILL.md`;
      const notice = body.length < skill.text.length
        ? `\n\n[Shortened to fit the message. Read ${filename} for the remaining instructions.]` : '';
      return `# Selected skill: /${skill.id}\nPath: ${filename}\n\n<SKILL_INSTRUCTIONS>\n${body}${notice}\n</SKILL_INSTRUCTIONS>`;
    }));
    if (agents && content) sections.push(`${projectHeader}\n\n# AGENTS.md instructions for ${agents.directory}\n\n<INSTRUCTIONS>\n${prefix(content, length)}${length < content.length || agents.truncated ? cutNotice : ''}\n</INSTRUCTIONS>`);
    else if (projectHeader) sections.push(projectHeader);
    return frame(text, [core, ...sections].filter(Boolean).join('\n\n'));
  };
  const full = render(content.length);
  if (fits(full)) return full;
  const largestFit = (low: number, high: number, candidate: (n: number) => string): string => {
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(candidate(middle))) low = middle;
      else high = middle - 1;
    }
    return candidate(low);
  };
  // Without Skills, retain the existing AGENTS-only fitting behavior.
  if (!skills.length) {
    if (!fits(render(0))) {
      if (agents?.tree || contextSections.length) {
        throw new Error('The message and required project/history context exceed the local provider limit. Shorten the request or project context before sending.');
      }
      return base;
    }
    return largestFit(0, content.length, n => render(n));
  }
  // Include the whole code point crossing the floor rather than dropping below it.
  let floor = Math.min(5_000, content.length);
  if (floor < content.length && /[\uD800-\uDBFF]/.test(content[floor - 1] ?? '')) floor++;
  if (fits(render(floor))) return largestFit(floor, content.length, n => render(n));
  // A common prefix cap shares space across all selected files; later skills never vanish.
  if (!fits(render(floor, 0))) throw new Error('The message, main instructions, 5,000-character AGENTS minimum and selected skill references exceed the delivery limit. Shorten the message or standing instructions.');
  return largestFit(0, Math.max(...skills.map(skill => skill.text.length)), n => render(floor, n));
}

/** Preserve Core/task; reduce AGENTS to 5k before sharing remaining space across Skills. */
export function fitSessionPrompt(text: string, core: string, agents: ProjectInstructions | null = null, budget = limits, skills: SelectedSkill[] = []): string {
  return fitPrompt(text, core, agents, budget, skills, prependUserPrompt);
}

/** Local provider messages use NEURAFLOK's own context boundary and never inherit MCP-client prose. */
export function fitProviderPrompt(
  text: string,
  core: string,
  agents: ProjectInstructions | null = null,
  budget = limits,
  skills: SelectedSkill[] = [],
  extraContext: { historySummary?: string; projectPlanPhase?: 'draft'; projectPlanContext?: string } = {}
): string {
  const contextSections = extraContext.historySummary
    ? [`# Recent conversation\n${extraContext.historySummary}`]
    : [];
  if (extraContext.projectPlanPhase === 'draft') contextSections.push([
    '# Plan first',
    'This is a project planning request. Inspect the relevant existing project files with the listed read-only tools before proposing a plan.',
    'Do not edit or create files, run commands, start agents, or make other changes. Do not guess about files you have not read.',
    'Then give a short, clear plan in the configured language and ask the user to approve it before starting work.'
  ].join('\n'));
  if (extraContext.projectPlanContext) contextSections.push(extraContext.projectPlanContext);
  if (!agents) return fitPrompt(text, core, agents, budget, skills, frameProviderPrompt, contextSections);
  const style = '\n\nFINAL RESPONSE STYLE: Answer the user\'s current question naturally and directly in the configured language. Keep it concise. Do not provide an audit report, tool transcript, command output, or file path list unless the user asks for those details. State only useful results and limitations; never invent work.';
  const styleBytes = Buffer.byteLength(style, 'utf8');
  const contentBudget = {
    maxChars: Math.max(0, budget.maxChars - style.length),
    maxBytes: Math.max(0, budget.maxBytes - styleBytes)
  };
  const framed = fitPrompt(text, core, agents, contentBudget, skills, frameProviderPrompt, contextSections);
  return `${framed}${style}`;
}

/** Opening normal/worker messages only. Callers own first-message eligibility; follow-ups, helpers, handoff requests and resumed bootstraps never call this. */
export async function prepareSessionPrompt(text: string, scope: PromptScope = {}, budget = limits, authored = text): Promise<string> {
  const folder = await promptFolder(scope);
  const skillScope = { projectPath: folder?.real ?? null };
  // Automatic routing has already frozen its decision from the app's published Skill catalog at admission, so those Skills come from that catalog: only the selected body is read below. Every other Skill the chat can use is still listed, exactly as without routing.
  const library = await listSkillLibrary(scope.autoSkills !== undefined ? { ...skillScope, managedFromCatalog: true } : skillScope);
  const core = await currentCoreInstructions(library);
  const skills = await selectedSkillInstructions(authored, skillScope, library, scope.autoSkills);
  fitSessionPrompt(text, core, null, budget); // Only Core/task overflow is mandatory.
  const agents = await projectInstructions(scope);
  if ((await promptFolder(scope))?.real !== folder?.real) throw new Error('The selected project changed during Skill preparation');
  return fitSessionPrompt(text, core, agents, budget, skills);
}

/** NEURAFLOK's local web/API executors share project and Skill context, not old MCP host instructions. */
export async function prepareProviderSessionPrompt(text: string, scope: PromptScope = {}, budget = limits, authored = text): Promise<string> {
  const folder = await promptFolder(scope);
  const skillScope = { projectPath: folder?.real ?? null };
  const library = await listSkillLibrary(scope.autoSkills !== undefined ? { ...skillScope, managedFromCatalog: true } : skillScope);
  const skills = await selectedSkillInstructions(authored, skillScope, library, scope.autoSkills);
  const core = localProviderInstructions(Boolean(folder));
  fitProviderPrompt(text, core, null, budget); // Required user request and provider contract.
  const agents = await projectInstructions(scope);
  if ((await promptFolder(scope))?.real !== folder?.real) throw new Error('The selected project changed during Skill preparation');
  return fitProviderPrompt(text, core, agents, budget, skills, {
    historySummary: scope.historySummary,
    projectPlanPhase: agents ? scope.projectPlanPhase : undefined,
    projectPlanContext: agents ? scope.projectPlanContext : undefined
  });
}

/** Explicit follow-up selection adds Skills only, never repeats opening setup. */
export async function prepareSkillFollowup(text: string, authored: string, budget = limits, scope: PromptScope = {}): Promise<string> {
  const folder = await promptFolder(scope);
  const skills = await selectedSkillInstructions(authored, { projectPath: folder?.real ?? null }, undefined, scope.autoSkills);
  if ((await promptFolder(scope))?.real !== folder?.real) throw new Error('The selected project changed during Skill preparation');
  return skills.length ? fitSessionPrompt(text, '', null, budget, skills) : text;
}

/** Later provider turns keep language and project directory, add selected Skills, and skip repeating opening AGENTS/setup. */
export async function prepareProviderSkillFollowup(text: string, authored: string, budget = limits, scope: PromptScope = {}): Promise<string> {
  // A resumed chat needs its current instructions and the selected project's
  // refreshed tree on every turn, plus a bounded summary of its prior work.
  return prepareProviderSessionPrompt(text, scope, budget, authored);
}
