import { webUtils } from "electron";
import type { InputAttachment } from "../../../contracts/input.js";
import { call, type Reply } from "./shared.js";

export function createAttachmentsApi() {
  return {
    chooseFiles: () => call<InputAttachment[]>('sessions:files'),
    dropFiles: async (files: File[]): Promise<Reply<InputAttachment[]>> => {
      if (!files.length || files.length > 20) return { ok: false, error: 'Attach up to 20 files per message' };
      try {
        const staged: Array<InputAttachment | undefined> = new Array(files.length);
        const paths: Array<{ index: number; path: string }> = [];
        const memory: Array<{ index: number; file: File }> = [];
        for (const [index, file] of files.entries()) {
          const path = webUtils.getPathForFile(file);
          if (!path && file.size > 12 * 1024 * 1024) return { ok: false, error: 'Pasted images must be 12 MB or smaller' };
          if (path) paths.push({ index, path });
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
          const reply = await call<InputAttachment[]>('sessions:dropFiles', { files: [{ name: entry.file.name, bytes }] });
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
