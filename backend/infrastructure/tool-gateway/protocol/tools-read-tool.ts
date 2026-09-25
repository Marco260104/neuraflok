import { z } from 'zod';
import { DEFAULT_READ_BYTES, MAX_READ_BYTES, formatBytes } from '../../../domains/workspace/fsops.js';
import {
  GLOB_SCAN_LIMIT,
  MAX_GLOB_MATCHES,
  MAX_READ_IMAGES,
  MAX_READ_IMAGE_BYTES,
  MAX_READ_TARGETS,
  expandGlob,
  hasGlob,
  nearestFolderListing,
  readOne,
  splitLineRange,
  type ReadTarget
} from './tools-read.js';
import { logInfo } from '../../settings/logger.js';
import { noteCount } from './call-context.js';
import { fail, friendlyError, guard, ok, type SurfaceRegistrar } from './kernel.js';
import { lineNumberArg, pathArg } from './tool-arguments.js';
import { toolDeclaration } from './declaration-cache.js';

export function registerFileReadTool(reg: SurfaceRegistrar): void {
  const { ctx, caps, exposedCaps } = reg;
  const virtualRoots = ctx.roots.map((root) => `/${root.name}`);
  const readPathDescription = virtualRoots.length > 0
    ? `Paths inside the live approved roots: ${virtualRoots.join(', ')}. A root is an approved folder, usually a parent of the project rather than the project itself, so name every folder between the root and the file — the same path exec_command takes as workdir. Reading a root lists it one level deep. ` +
      'Absolute native paths copied from command output are also accepted when they resolve inside one of these roots; globs work in either spelling.'
    : 'Paths require an approved virtual root in the form /<root>/...; no root is currently approved. Globs are supported after a root is approved.';

  if (!exposedCaps.read && !exposedCaps.browse && !exposedCaps.metadata) return;

  reg.register(
    'read',
    toolDeclaration('read', () => ({
      title: 'Read files and folders',
      description:
        'Read what is at one or more paths. A folder is listed one level deep, a text file comes back as numbered lines, ' +
        'a PNG/JPEG/GIF/WebP comes back as an image, and anything else returns its metadata and why it was not decoded. ' +
        'Paths may contain * ? and ** and are expanded here. Every result starts with a header giving size, timestamps and line count. ' +
        'The line-number prefix is display metadata, not file content — strip it before quoting text into apply_patch. ' +
        'start_line/end_line apply to every file the call resolves to; a path may instead carry its own range as path:12-40 or path:12, so several ranges of one file fit in one call. A typical 1,500-line source file fits in the default read: do not pre-paginate it. ' +
        `Batch related paths in one call; only continue from a line when the returned header says more lines follow. Text is bounded at about ${formatBytes(MAX_READ_BYTES)}; images have a separate ${MAX_READ_IMAGES}-image, ${formatBytes(MAX_READ_IMAGE_BYTES)} base64 budget and view_image's per-file validation.`,
      inputSchema: z
        .object({
          paths: z.array(pathArg).min(1).max(20).describe(readPathDescription),
          start_line: lineNumberArg
            .optional()
            .describe('First line, 1-based. Applied to every file the call reads, so prefer one path when the range is file-specific.'),
          end_line: lineNumberArg
            .optional()
            .describe('Last line, inclusive. Applied to every file the call reads, so prefer one path when the range is file-specific.'),
          max_bytes: z
            .number()
            .int()
            .min(1)
            .max(MAX_READ_BYTES)
            .optional()
            .describe(
              `Per-text-file payload cap. Default ${formatBytes(DEFAULT_READ_BYTES)}; maximum ${formatBytes(MAX_READ_BYTES)}. Omit it for ordinary source files.`
            )
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }), readPathDescription),
    async ({ paths, start_line, end_line, max_bytes }) =>
      guard('read', async () => {
        if (!caps.read && !caps.browse && !caps.metadata) {
          return fail(
            'TOOL_DISABLED: read is disabled by the current NEURAFLOK permissions. Ask the user to enable reading in the app.'
          );
        }
        const targets: ReadTarget[] = [];
        const notes: string[] = [];
        for (const item of paths) {
          if (targets.length >= MAX_READ_TARGETS) {
            notes.push(`(stopped expanding at ${MAX_READ_TARGETS} paths)`);
            break;
          }
          const { path: requested, range } = splitLineRange(item);
          if (!hasGlob(requested)) {
            targets.push({ path: requested, range });
            continue;
          }
          const expanded = await expandGlob(ctx.roots, requested);
          if (expanded.matches.length === 0) {
            notes.push(
              expanded.truncated === 'scan'
                ? `${requested}: glob scan stopped after ${GLOB_SCAN_LIMIT} entries before finding a match; narrow the pattern or start from a deeper folder`
                : `${requested}: no matches`
            );
            continue;
          }
          targets.push(
            ...expanded.matches.slice(0, MAX_READ_TARGETS - targets.length).map((match) => ({ path: match, range }))
          );
          if (expanded.truncated === 'matches') {
            notes.push(`${requested}: more than ${MAX_GLOB_MATCHES} matches, narrow the pattern`);
          } else if (expanded.truncated === 'scan') {
            notes.push(
              `${requested}: glob scan stopped after ${GLOB_SCAN_LIMIT} entries; more matches may exist, narrow the pattern or start from a deeper folder`
            );
          }
        }

        const ranged = start_line !== undefined || end_line !== undefined;
        const sharedRange = targets.filter((target) => target.range === null).length;
        if (sharedRange > 1 && ranged) {
          notes.push(
            `(start_line/end_line applied to each of the ${sharedRange} files this call resolved to; every header states the lines actually returned)`
          );
        }
        const sections: string[] = [];
        const images: Array<{ data: string; mimeType: string }> = [];
        let remaining = MAX_READ_BYTES;
        let imageBytes = 0;
        let failures = 0;
        let successes = 0;

        for (const target of targets) {
          if (remaining <= 0) {
            sections.push('(output cap reached; read the remaining paths in another call)');
            break;
          }
          try {
            const section = await readOne(target.path, {
              roots: ctx.roots,
              canRead: caps.read,
              canBrowse: caps.browse,
              startLine: target.range ? target.range.start : start_line,
              endLine: target.range ? target.range.end : end_line,
              maxBytes: Math.min(max_bytes ?? DEFAULT_READ_BYTES, remaining),
              imageBytes: images.length < MAX_READ_IMAGES ? MAX_READ_IMAGE_BYTES - imageBytes : 0
            });
            remaining -= section.bytes;
            successes++;
            sections.push(section.text);
            if (section.image) {
              images.push(section.image);
              imageBytes += section.image.data.length;
            }
          } catch (error) {
            failures++;
            const nearby = caps.browse ? await nearestFolderListing(ctx.roots, target.path, error) : '';
            sections.push(`--- ${target.path} — ERROR ---\n${friendlyError(error)}${nearby}`);
          }
        }

        logInfo(`tool read (${targets.length} target(s), ${failures} failed)`);
        noteCount(successes);
        const text = [...sections, ...notes].join('\n\n');
        if (targets.length > 0 && failures === targets.length) return fail(text || 'Nothing could be read.');
        if (images.length === 0) return ok(text || 'Nothing to read.');
        return {
          content: [
            { type: 'text' as const, text },
            ...images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))
          ]
        };
      })
  );
}
