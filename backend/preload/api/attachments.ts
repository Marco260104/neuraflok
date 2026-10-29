import { webUtils } from "electron";
import type { InputAttachment } from "../../../contracts/input.js";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_SIZE_BYTES } from "../../../contracts/attachments.js";
import { call, type Reply } from "./shared.js";

export function createAttachmentsApi() {
  const imageExtension: Record<string, string> = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/pjpeg": ".jpg", "image/webp": ".webp",
    "image/gif": ".gif", "image/bmp": ".bmp", "image/avif": ".avif", "image/heic": ".heic",
    "image/heif": ".heif", "image/tiff": ".tiff", "image/svg+xml": ".svg", "image/x-icon": ".ico"
  };
  return {
    chooseFiles: () => call<InputAttachment[]>('sessions:files'),
    dropFiles: async (files: File[]): Promise<Reply<InputAttachment[]>> => {
      if (!files.length || files.length > MAX_ATTACHMENTS_PER_MESSAGE) return { ok: false, error: 'Attach up to 50 files per message' };
      try {
        const staged: Array<InputAttachment | undefined> = new Array(files.length);
        const paths: Array<{ index: number; path: string }> = [];
        const memory: Array<{ index: number; file: File }> = [];
        for (const [index, file] of files.entries()) {
          if (file.size > MAX_ATTACHMENT_SIZE_BYTES) return { ok: false, error: 'Each attachment must be 100 MB or smaller' };
          const mimeType = typeof file.type === 'string' ? file.type.toLowerCase() : '';
          const path = webUtils.getPathForFile(file);
          // Clipboard image files can have a temporary path without a useful
          // extension. Keep their declared MIME type by staging their bytes
          // under a matching image name instead of guessing from that path.
          if (mimeType.startsWith('image/')) memory.push({ index, file });
          else if (path) paths.push({ index, path });
          else memory.push({ index, file });
        }
        // Send clipboard bytes one at a time and keep disk attachments as paths.
        if (paths.length) {
          const reply = await call<InputAttachment[]>('sessions:dropFiles', { files: paths.map(entry => entry.path) });
          if (!reply.ok) return reply;
          if (reply.data.length !== paths.length) return { ok: false, error: 'Could not stage the attachments' };
          for (const [offset, entry] of paths.entries()) staged[entry.index] = reply.data[offset];
        }
        for (const entry of memory) {
          const bytes = new Uint8Array(await entry.file.arrayBuffer());
          const rawName = entry.file.name.trim();
          const mimeType = typeof entry.file.type === 'string' ? entry.file.type.toLowerCase() : '';
          const extension = imageExtension[mimeType];
          const existingExtension = /\.[^./\\]+$/.exec(rawName)?.[0].toLowerCase();
          const matchingImageExtension = extension && existingExtension &&
            (existingExtension === extension || (extension === '.jpg' && ['.jpeg', '.jpe', '.jfif'].includes(existingExtension)));
          const fallbackExtension = extension ?? (mimeType.startsWith('image/')
            ? `.${mimeType.slice('image/'.length).replace(/[^a-z0-9]+.*$/i, '') || 'unknown'}` : '');
          const baseName = rawName && existingExtension && !extension ? rawName : rawName.replace(/\.[^./\\]+$/, '');
          const name = rawName && (!extension || matchingImageExtension) ? rawName : `${baseName || (mimeType.startsWith('image/') ? 'Pasted image' : 'Attached file')}${fallbackExtension}`;
          const reply = await call<InputAttachment[]>('sessions:dropFiles', { files: [{ name, bytes }] });
          if (!reply.ok) return reply;
          if (reply.data.length !== 1) return { ok: false, error: 'Could not stage the attachment' };
          staged[entry.index] = reply.data[0];
        }
        if (staged.some(attachment => !attachment)) return { ok: false, error: 'Could not stage the attachments' };
        return { ok: true, data: staged as InputAttachment[] };
      } catch { return { ok: false, error: 'Could not read the attachment' }; }
      },
    attachText: (text: string) => call<InputAttachment>('sessions:attachText', { text })
  };
}
