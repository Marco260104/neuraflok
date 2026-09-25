import path from 'node:path';
import sharp from 'sharp';
import { rawPromises as fs } from '../../rawfs.js';
import { statInfo } from '../reads/file-metadata.js';
import { readTextFile } from '../reads/text-range-reader.js';
import { MAX_IMAGE_PREVIEW_BYTES, MAX_PDF_PREVIEW_BYTES, MAX_PREVIEW_BYTES } from './limits.js';
import { projectFileTarget, recheckTarget, sameFile } from './target.js';
import { textSnapshot } from './text-snapshot.js';
import type { ProjectFilePreview } from '../../../../../contracts/workspace/project-files.js';

const IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon']
]);


export async function previewProjectFile(projectId: string, relativePath: string): Promise<ProjectFilePreview> {
  const target = await projectFileTarget(projectId, relativePath, { allowRoot: false, fileOnly: true });
  const info = await statInfo(target.real, target.path, { scanContent: true });
  if (info.type !== 'file') throw new Error('Choose a regular file');
  const extension = path.extname(target.real).toLowerCase();
  const imageMimeType = IMAGE_MIME_BY_EXTENSION.get(path.extname(target.real).toLowerCase());
  if (imageMimeType && info.bytes <= MAX_IMAGE_PREVIEW_BYTES) {
    // Re-check the opened file and cap the payload so a concurrent growth cannot turn a small preview request into an unbounded allocation or IPC message.
    const handle = await fs.open(target.real, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Choose a regular file');
      if (stat.size > MAX_IMAGE_PREVIEW_BYTES) {
        return {
          projectId,
          projectName: target.projectName,
          path: target.path,
          name: path.basename(target.real),
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          binary: true,
          text: null,
          truncated: true,
          note: 'Image is too large for the bounded preview.'
        };
      }
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const data = offset === buffer.length ? buffer : buffer.subarray(0, offset);
      // Decode under a pixel limit and publish one bounded raster thumbnail. Compressed bytes alone do not bound browser memory, and a filename is not proof of image content.
      let image: Buffer;
      try {
        image = await sharp(data, { failOn: 'warning', limitInputPixels: 16 * 1024 * 1024, sequentialRead: true })
          .rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      } catch {
        return { projectId, projectName: target.projectName, path: target.path, name: path.basename(target.real),
          bytes: stat.size, modifiedAt: stat.mtime.toISOString(), binary: true, text: null, truncated: false,
          note: 'Image preview unavailable. The file is invalid, unsupported or exceeds the pixel limit.' };
      }
      await recheckTarget(target);
      if (!sameFile(stat, await handle.stat())) throw new Error('File changed while being read');
      return {
        projectId,
        projectName: target.projectName,
        path: target.path,
        name: path.basename(target.real),
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        binary: true,
        text: null,
        imageMimeType: 'image/png',
        imageDataUrl: `data:image/png;base64,${image.toString('base64')}`,
        truncated: false
      };
    } finally {
      await handle.close();
    }
  }
  if (extension === '.pdf') {
    const handle = await fs.open(target.real, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Choose a regular file');
      if (stat.size > MAX_PDF_PREVIEW_BYTES) {
        return {
          projectId,
          projectName: target.projectName,
          path: target.path,
          name: path.basename(target.real),
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          binary: true,
          text: null,
          truncated: true,
          note: 'PDF is too large for the bounded in-app preview.'
        };
      }
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const data = offset === buffer.length ? buffer : buffer.subarray(0, offset);
      await recheckTarget(target);
      if (!sameFile(stat, await handle.stat())) throw new Error('File changed while being read');
      // Fail closed on a misleading .pdf extension instead of giving arbitrary binary bytes to a document parser. PDF headers are normally at byte zero; tolerate a small prefix.
      if (!data.subarray(0, Math.min(1024, data.length)).includes(Buffer.from('%PDF-'))) {
        return {
          projectId,
          projectName: target.projectName,
          path: target.path,
          name: path.basename(target.real),
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          binary: true,
          text: null,
          truncated: false,
          note: 'This .pdf file does not contain a PDF header.'
        };
      }
      return {
        projectId,
        projectName: target.projectName,
        path: target.path,
        name: path.basename(target.real),
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        binary: true,
        text: null,
        pdfDataBase64: data.toString('base64'),
        truncated: false
      };
    } finally {
      await handle.close();
    }
  }
  if (info.binary === true) {
    return {
      projectId,
      projectName: target.projectName,
      path: target.path,
      name: path.basename(target.real),
      bytes: info.bytes,
      modifiedAt: info.modified,
      binary: true,
      text: null,
      truncated: Boolean(imageMimeType && info.bytes > MAX_IMAGE_PREVIEW_BYTES),
      ...(imageMimeType && info.bytes > MAX_IMAGE_PREVIEW_BYTES
        ? { note: 'Image is too large for the bounded preview.' }
        : {})
    };
  }
  let read;
  if (info.bytes <= MAX_PREVIEW_BYTES) {
    try {
      const snapshot = await textSnapshot(target);
      return { projectId, projectName: target.projectName, path: target.path, name: path.basename(target.real),
        bytes: snapshot.data.length, modifiedAt: snapshot.stat.mtime.toISOString(), binary: false,
        text: snapshot.text, revision: snapshot.revision, truncated: false };
    } catch (error) {
      if (!(error instanceof Error) || !/not UTF-8|Binary files/.test(error.message)) throw error;
      return { projectId, projectName: target.projectName, path: target.path, name: path.basename(target.real),
        bytes: info.bytes, modifiedAt: info.modified, binary: true, text: null, truncated: false, note: error.message };
    }
  }
  try {
    read = await readTextFile(target.real, { maxBytes: MAX_PREVIEW_BYTES });
  } catch (error) {
    if (error instanceof Error && /Line \d+ is larger than max_bytes=/.test(error.message)) {
      return {
        projectId,
        projectName: target.projectName,
        path: target.path,
        name: path.basename(target.real),
        bytes: info.bytes,
        modifiedAt: info.modified,
        binary: false,
        text: null,
        truncated: true,
        note: 'This file contains a line that is too large for the bounded preview.'
      };
    }
    throw error;
  }
  return {
    projectId,
    projectName: target.projectName,
    path: target.path,
    name: path.basename(target.real),
    bytes: info.bytes,
    modifiedAt: info.modified,
    binary: false,
    text: read.text,
    truncated: read.truncated || read.hasMore
  };
}
