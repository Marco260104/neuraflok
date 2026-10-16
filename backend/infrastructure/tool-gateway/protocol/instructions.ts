import { browserInstructions } from './guidance/browser-instructions.js';
import { coreInstructions } from './guidance/core-instructions.js';
import { desktopInstructions } from './guidance/desktop-instructions.js';
import { userInstructions } from './guidance/user-instructions.js';
import { skillCatalogInstructions } from '../../../domains/skills/storage/catalog.js';
import { listSkillLibrary, skillLibraryInstructions } from '../../../domains/skills/skill-library.js';
import type { SkillLibrary } from '../../../../contracts/skills.js';
import { withManagedSkills } from '../../../domains/skills/access/managed-roots.js';
import { CODE_MODE_INSTRUCTIONS } from './code-mode-tool.js';
import { effectiveCapabilities, getConfig } from '../../settings/config.js';
import type { ToolContext } from './kernel.js';
import type { SurfaceId } from './surfaces.js';

export function serverInstructions(
  ctx: ToolContext,
  surface: SurfaceId = 'core',
  platform: NodeJS.Platform = process.platform,
  skills = skillCatalogInstructions()
): string {
  if (surface === 'core') return coreInstructions(ctx, platform, skills);
  const desktop = platform === 'win32' || platform === 'darwin'
    ? desktopInstructions(ctx, platform)
    : ['Files and shell commands are local workspace tools.', CODE_MODE_INSTRUCTIONS, ...userInstructions()].join('\n\n');
  return [browserInstructions(), desktop].join('\n\n');
}

export async function currentCoreInstructions(library?: SkillLibrary): Promise<string> {
  const skills = library ?? await listSkillLibrary();
  const config = getConfig();
  const context = withManagedSkills({
    roots: config.roots,
    caps: effectiveCapabilities(config),
    readOnly: config.readOnly,
    privacyScreenshots: config.ui.privacyScreenshots
  });
  return coreInstructions(context, process.platform, skillLibraryInstructions(skills));
}
