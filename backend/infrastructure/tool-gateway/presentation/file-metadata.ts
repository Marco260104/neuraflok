import { formatBytes, type FileInfo } from '../../../domains/workspace/fsops.js';

type MetadataValue = string | number | boolean;

export function formatWorkspaceFileMetadata(info: FileInfo): string {
  const required = new Map<string, MetadataValue>([
    ['path', info.virtualPath],
    ['type', info.type],
    ['size', formatBytes(info.bytes)],
    ['modified', info.modified],
    ['created', info.created]
  ]);
  const optional = new Map<string, MetadataValue>();

  if (info.readOnly) optional.set('readonly', true);
  if (info.binary !== null) optional.set('binary', info.binary);
  if (info.lines !== null) optional.set('lines', info.lines);
  if (info.sha256) optional.set('sha256', info.sha256);

  return [...required, ...optional]
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join('\n');
}
