import { toolDeclaration } from './declaration-cache.js';
import { firstTaskRoot } from '../../../domains/skills/access/managed-roots.js';
import { registerPlanTool } from './plan-tool.js';
import { applyPatchErrorText, runParsedPatch } from './tools-patching.js';
import { registerAgentsTool } from './tools-agents.js';
import { registerExecutionTools } from './tools-execution.js';
import { goalWorkerChat } from '../../../domains/browser/bridge.js';
import { announceSessionFinish, sessionFinishDeadline } from '../../../domains/sessions/input/finish.js';
import { getConfig } from '../../settings/config.js';
// Register the local file, execution, image, and workspace tools exposed through Core.

import { z } from 'zod';
import { formatBytes } from '../../../domains/workspace/fsops.js';
import {
  IMAGE_INSPECTION_DESCRIPTION,
  IMAGE_PATH_DESCRIPTION,
  ImageInspectionError,
  inspectLocalImage
} from '../../../domains/workspace/execution/image-inspection.js';
import { logInfo } from '../../settings/logger.js';
import { isAbsoluteVirtualPath, isNativeWindowsPath } from '../../settings/sandbox.js';
import { currentWorkspace } from '../../../domains/workspace/workspace.js';
import { parsePatch, type Hunk } from '../../../domains/workspace/execution/apply-patch/index.js';
import {
  APPLY_PATCH_ARGUMENT_DESCRIPTION,
  APPLY_PATCH_DESCRIPTION
} from '../../../domains/workspace/execution/tool-specs.js';
import { swarmRunning } from '../../../domains/automation/agents.js';
import {
  currentCall,
  currentCaller
} from './call-context.js';
import {
  fail,
  failIdentity,
  guard,
  resolveIn,
  type SurfaceRegistrar,
  type ToolResult
} from './kernel.js';
import { registerFindTool } from './tools-find.js';
import { registerFileReadTool } from './tools-read-tool.js';

export function registerCoreTools(reg: SurfaceRegistrar): void {
  const { ctx, caps, exposedCaps } = reg;
  registerFileReadTool(reg);

  // Image viewer tool.

  if (exposedCaps.read) {
    reg.register(
      'view_image',
      toolDeclaration('view_image', () => ({
        description: IMAGE_INSPECTION_DESCRIPTION,
        inputSchema: z
          .object({
            path: z.string().describe(IMAGE_PATH_DESCRIPTION)
          })
          .strict()
      })),
      async ({ path }) =>
        guard('view_image', async () => {
          if (!caps.read) {
            return fail(
              'TOOL_DISABLED: view_image is disabled by the current NEURAFLOK permissions. Ask the user to enable reading in the app.'
            );
          }
          const resolved = await resolveIn(ctx.roots, path, { access: 'read' });
          try {
            const image = await inspectLocalImage(resolved.real, resolved.virtual);
            logInfo(`tool view_image ${resolved.virtual} (${formatBytes(image.bytes)})`);
            return {
              content: [{ type: 'image' as const, data: image.base64, mimeType: image.mimeType }]
            };
          } catch (error) {
            if (error instanceof ImageInspectionError) return fail(error.message);
            throw error;
          }
        })
    );
  }

  registerFindTool(reg);

  // Patch application tool.

  if (exposedCaps.create || exposedCaps.edit || exposedCaps.move || exposedCaps.deleteFile) {
    reg.register(
      'apply_patch',
      toolDeclaration('apply_patch', () => ({
        description: APPLY_PATCH_DESCRIPTION,
        inputSchema: z
          .object({
            patch: z.string().describe(APPLY_PATCH_ARGUMENT_DESCRIPTION)
          })
          .strict()
      })),
      async ({ patch }) =>
        guard('apply_patch', async () => {
          if (!caps.create && !caps.edit && !caps.move && !caps.deleteFile) {
            return fail(
              'TOOL_DISABLED: apply_patch is disabled by the current NEURAFLOK permissions. Ask the user to enable changing files in the app.'
            );
          }

          let args: { patch: string; hunks: Hunk[]; workdir: string | null; environmentId: string | null };
          try {
            args = parsePatch(patch);
          } catch (error) {
            return fail(`apply_patch verification failed: ${applyPatchErrorText(error)}`);
          }

          // Reject environment selection because this connector exposes one local environment.
          if (args.environmentId !== null) {
            return fail('apply_patch environment selection is unavailable for this turn');
          }
          const workspace = currentWorkspace();
          const hasRelativePath = args.hunks.some(hunk => {
            const paths = hunk.kind === 'update_file' && hunk.movePath !== null
              ? [hunk.path, hunk.movePath]
              : [hunk.path];
            return paths.some(path => !isAbsoluteVirtualPath(path) && !isNativeWindowsPath(path));
          });
          if (!workspace && swarmRunning() && hasRelativePath) {
            return fail(
              'WORKSPACE_REQUIRED: this request has no workspace yet. Use an absolute approved path in this patch or another file tool first so the project can be learned.'
            );
          }
          const fallback = firstTaskRoot(ctx.roots);
          const baseVirtual = workspace?.virtual ?? (fallback ? `/${fallback.name}` : null);
          if (baseVirtual === null) {
            return fail('No folder is approved, so there is nowhere to apply the patch.');
          }
          const base = await resolveIn(ctx.roots, baseVirtual);
          return (await runParsedPatch(args, ctx.roots, base, caps)).result;
        })
    );
  }

  registerExecutionTools(reg);

  // Plan and finish section.

  if (reg.sessionToolsExposed) {
    registerPlanTool(reg);
  }
  if (reg.ctx.exposedFinishTool ?? getConfig().ui.finishTool === true) {
    reg.register('session_finish', toolDeclaration('session_finish', () => ({
      description: 'Only when explicitly requested by a user prompt, with any model. Call near actual completion, after implementing the requested work. Receives queued instructions; complete and verify them before calling again. Do not use for progress updates or queue collection. While HELD with no work remaining, call to wait. Each call waits at most 25 seconds.',
      inputSchema: z.object({ summary: z.string().min(1).max(1000) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    })), async ({ summary }) => {
      if (!getConfig().ui.finishTool) return { content: [{ type: 'text' as const, text: 'RELEASED: The user disabled finish hold. You may write your final answer.' }] };
      const caller = currentCaller();
      if (!caller.sessionId || !caller.conversationId) return failIdentity('Exact session identity is required');
      if (goalWorkerChat(caller.conversationId)) return fail('Session finish hold is not applicable to workers or decision helpers. Workers report with agents action=finish; decision helpers answer normally.');
      const deadline = sessionFinishDeadline(currentCall()?.startedAt ?? Date.now());
      return guard('session_finish', async () => ({ content: [{ type: 'text', text: await announceSessionFinish(caller.sessionId!, summary, deadline) }] }));
    });
  }


  // Agents section.

  if (reg.agentToolsExposed) registerAgentsTool(reg);
}


export type { ToolResult };


