import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const MAX_PROVIDER_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PROVIDER_PDF_PAGES = 300;

type PromiseWithResolversConstructor = typeof Promise & {
  withResolvers?: <T>() => { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void };
};

function ensurePromiseWithResolvers(): void {
  const promiseConstructor = Promise as PromiseWithResolversConstructor;
  if (promiseConstructor.withResolvers) return;
  Object.defineProperty(Promise, 'withResolvers', {
    configurable: true,
    value<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
      return { promise, resolve, reject };
    }
  });
}

/** Extract selectable text while bounding the PDF bytes, page count and text sent to a provider. Scanned pages stay image-only. */
export async function extractProviderPdfText(bytes: Buffer, maxTextBytes = 1_000_000): Promise<string> {
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > 1_000_000) {
    throw new Error('Invalid PDF text limit');
  }
  if (bytes.length < 5 || bytes.length > MAX_PROVIDER_PDF_BYTES || bytes.toString('ascii', 0, 5) !== '%PDF-') {
    throw new Error('Attach a valid PDF of 20 MB or smaller.');
  }

  ensurePromiseWithResolvers();
  const loading = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useWorkerFetch: false,
    useSystemFonts: true,
    verbosity: 0
  });
  try {
    const pdf = await loading.promise;
    if (pdf.numPages > MAX_PROVIDER_PDF_PAGES) {
      throw new Error(`This PDF has ${pdf.numPages} pages; attach a document with up to ${MAX_PROVIDER_PDF_PAGES} pages.`);
    }

    const pages: string[] = [];
    let outputBytes = 0;
    let foundText = false;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let line = '';
      for (const item of content.items) {
        if (!('str' in item) || !item.str) continue;
        line += `${item.str}${item.hasEOL ? '\n' : ' '}`;
      }
      for (const part of line.split(/\r?\n/)) {
        const normalized = part.replace(/[\t ]+/g, ' ').trim();
        if (normalized) lines.push(normalized);
      }
      if (!lines.length) continue;
      foundText = true;
      const section = `[Page ${pageNumber}]\n${lines.join('\n')}`;
      outputBytes += Buffer.byteLength(section, 'utf8') + 2;
      if (outputBytes > maxTextBytes) {
        throw new Error('The extracted PDF text exceeds the 500 KB inline context limit. Add its folder as a project instead.');
      }
      pages.push(section);
    }

    if (!foundText) {
      throw new Error('This PDF has no selectable text. It may be scanned or image-only; use DeepSeek Web to attach the original PDF so it can inspect the page images.');
    }
    return pages.join('\n\n');
  } catch (error) {
    if (error instanceof Error && /^(Attach a valid PDF|This PDF has|The extracted PDF text|This PDF has no selectable text)/.test(error.message)) throw error;
    throw new Error('Could not read this PDF. Check that it opens correctly, then attach it again.');
  } finally {
    await loading.destroy().catch(() => undefined);
  }
}
