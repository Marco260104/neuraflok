import { expect, it } from 'vitest';
import { formatBytes } from '../backend/domains/workspace/fsops.js';
import { formatWorkspaceFileMetadata } from '../backend/infrastructure/tool-gateway/presentation/file-metadata.js';

it('formats workspace metadata in the stable tool output order', () => {
  const info = {
    virtualPath: 'src/main.ts',
    type: 'file',
    bytes: 1536,
    modified: '2026-10-18T12:00:00.000Z',
    created: '2026-10-17T12:00:00.000Z',
    readOnly: true,
    binary: false,
    lines: 24,
    sha256: 'abc123'
  } as const;

  expect(formatWorkspaceFileMetadata(info).split('\n')).toEqual([
    'path: src/main.ts',
    'type: file',
    `size: ${formatBytes(info.bytes)}`,
    `modified: ${info.modified}`,
    `created: ${info.created}`,
    'readonly: true',
    'binary: false',
    'lines: 24',
    'sha256: abc123'
  ]);
});

it('omits optional file fields that have no value', () => {
  const info = {
    virtualPath: 'empty.txt',
    type: 'file',
    bytes: 0,
    modified: 'unknown',
    created: 'unknown',
    readOnly: false,
    binary: null,
    lines: null,
    sha256: null
  } as const;

  expect(formatWorkspaceFileMetadata(info).split('\n')).toEqual([
    'path: empty.txt',
    'type: file',
    `size: ${formatBytes(0)}`,
    'modified: unknown',
    'created: unknown'
  ]);
});
