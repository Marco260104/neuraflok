import { z } from 'zod';
import { rawPromises as fs } from '../../../domains/workspace/rawfs.js';
import { DEFAULT_EXCLUDES } from '../../../domains/workspace/file-ops/search/contracts.js';
import { MAX_CONTENT_FILE_BYTES } from '../../../domains/workspace/file-ops/search/limits.js';
import { search, searchOneFile } from '../../../domains/workspace/file-ops/search/service.js';
import { formatBytes } from '../../../domains/workspace/fsops.js';
import { resolvePath } from '../../settings/sandbox.js';
import { fail, ok, resolveIn, type SurfaceRegistrar } from './kernel.js';
import { noteCount } from './call-context.js';
import { toolDeclaration } from './declaration-cache.js';
import { pathArg } from './tool-arguments.js';

const excludeFolderPattern = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (value) =>
      !/[\\/]/.test(value) &&
      (value.indexOf('*') === -1 || (value.endsWith('*') && value.indexOf('*') === value.length - 1)),
    'exclude entries must be folder names with at most one trailing * prefix wildcard'
  );

export function registerFindTool(reg: SurfaceRegistrar): void {
  const { ctx } = reg;
  if (!reg.findExposed) return;

  reg.register(
    'find',
    toolDeclaration('find', () => ({
      title: 'Find files or text',
      description:
        'Find files by name, or find text inside files, without running a command. ' +
        `Content matches come back as path:line: text; files over ${formatBytes(MAX_CONTENT_FILE_BYTES)} are skipped rather than loaded into search. ` +
        'Build and dependency folders are skipped unless you pass your own exclude list.',
      inputSchema: z
        .object({
          query: z
            .string()
            .max(1000)
            .refine((value) => value.trim().length > 0, 'query must contain non-whitespace text')
            .describe('Text to look for'),
          path: pathArg
            .optional()
            .describe('File or folder to search. Virtual paths and absolute native paths inside approved roots are accepted. Defaults to every approved root.'),
          mode: z.enum(['name', 'content']).optional().describe('Default name.'),
          include: z.string().max(200).optional().describe('Glob filter such as **/*.ts'),
          exclude: z
            .array(excludeFolderPattern)
            .max(50)
            .optional()
            .describe('Folder names to skip; trailing * is a prefix match. Replaces the defaults — pass [] to search everywhere.'),
          case_sensitive: z.boolean().optional().describe('Default false.'),
          regex: z.boolean().optional().describe('Content mode only: treat query as a regex. Default false.'),
          max_results: z.number().int().min(1).max(500).optional().describe('Default 50.')
        })
        .superRefine((input, validation) => {
          if ((input.mode ?? 'name') !== 'content' && input.regex === true) {
            validation.addIssue({
              code: 'custom',
              path: ['regex'],
              message: 'regex=true is only valid with mode=content'
            });
          }
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    })),
    async ({ query, path: selectedPath, mode, include, exclude, case_sensitive, regex, max_results }) =>
      reg.guarded('search', 'find', async () => {
        const limit = Math.min(500, Math.max(1, Math.floor(max_results ?? 50)));
        const deadline = Date.now() + 10_000;
        const scopes: Array<{ real: string; virtual: string }> = [];
        if (selectedPath) {
          const resolved = await resolveIn(ctx.roots, selectedPath, { access: 'read' });
          const stat = await fs.stat(resolved.real);
          if (stat.isFile()) {
            const outcome = await searchOneFile(resolved.real, resolved.virtual, {
              query,
              mode: mode ?? 'name',
              include,
              caseSensitive: case_sensitive === true,
              regex: regex === true,
              maxResults: limit,
              deadline
            });
            const hits = outcome.hits.map((hit) =>
              hit.line === undefined ? hit.path : `${hit.path}:${hit.line}: ${hit.text}`
            );
            noteCount(hits.length);
            if (outcome.stoppedBecause === 'size') {
              return fail(
                `File was not searched: content search skips files over ${formatBytes(MAX_CONTENT_FILE_BYTES)}. ` +
                  'Narrow it with read start_line/end_line, or use exec_command when command execution is available.'
              );
            }
            return ok(hits.length === 0 ? 'No matches' : `${hits.length} matches\n${hits.join('\n')}`);
          }
          if (!stat.isDirectory()) return fail(`${resolved.virtual} is not a regular file or folder`);
          scopes.push({ real: resolved.real, virtual: resolved.virtual });
        } else {
          for (const root of ctx.roots) {
            const resolved = await resolvePath(ctx.roots, `/${root.name}`);
            scopes.push({ real: resolved.real, virtual: resolved.virtual });
          }
        }
        if (scopes.length === 0) return fail('No folders are approved');

        const hits: string[] = [];
        const stopReasons = new Set<string>();
        let scanned = 0;
        let elapsedMs = 0;
        for (const scope of scopes) {
          if (Date.now() >= deadline) {
            stopReasons.add('time');
            break;
          }
          if (hits.length >= limit) break;
          const outcome = await search({
            realDir: scope.real,
            virtualDir: scope.virtual,
            query,
            mode: mode ?? 'name',
            include,
            exclude: exclude ?? DEFAULT_EXCLUDES,
            caseSensitive: case_sensitive === true,
            regex: regex === true,
            maxResults: limit - hits.length,
            deadline
          });
          scanned += outcome.filesScanned;
          elapsedMs += outcome.elapsedMs;
          if (outcome.stoppedBecause) stopReasons.add(outcome.stoppedBecause);
          for (const hit of outcome.hits) {
            hits.push(hit.line === undefined ? hit.path : `${hit.path}:${hit.line}: ${hit.text}`);
          }
        }
        noteCount(hits.length);
        const reason = stopReasons.size > 0 ? `\ntruncated: ${[...stopReasons].join(',')}` : '';
        const contentLimit = (mode ?? 'name') === 'content' ? `\ncontent_file_limit: ${formatBytes(MAX_CONTENT_FILE_BYTES)}` : '';
        const meta = `\n\nfiles_scanned: ${scanned}\nelapsed_ms: ${elapsedMs}\nresults_returned: ${hits.length}${contentLimit}${reason}`;
        if (hits.length === 0) return ok(`No matches${meta}`);
        return ok(`${hits.length} matches\n${hits.join('\n')}${meta}`);
      })
  );
}
