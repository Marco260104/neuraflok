import { CODE_MODE_INSTRUCTIONS } from '../code-mode-tool.js';
import { getConfig } from '../../../settings/config.js';
import type { ToolContext } from '../kernel.js';
import { userInstructions } from './user-instructions.js';
import { collaborationGuidance } from './core/collaboration-guidance.js';
import { localToolGuidance } from './core/local-tool-guidance.js';
import { describeCoreWorkspace } from './core/workspace-context.js';
import { WORKSPACE_CODING_GUIDANCE } from '../coding-instructions.js';

export function coreInstructions(ctx: ToolContext, platform: NodeJS.Platform, skills: string): string {
  const config = getConfig();
  const workspace = describeCoreWorkspace(ctx, platform, config);
  return [
    WORKSPACE_CODING_GUIDANCE,
    skills,
    '',
    ...localToolGuidance(ctx, config, workspace),
    ...collaborationGuidance(ctx, config, workspace),
    '',
    CODE_MODE_INSTRUCTIONS,
    ...userInstructions()
  ].join('\n');
}
