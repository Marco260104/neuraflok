export const MAX_ATTACHMENTS_PER_MESSAGE = 50;
export const MAX_ATTACHMENT_SIZE_BYTES = 100 * 1024 * 1024;

function extensionOf(name: string): string {
  const leaf = name.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(dot).toLowerCase() : '';
}

const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.jpe', '.jfif', '.webp', '.gif', '.bmp']);

const OFFICE_EXTENSIONS = new Set([
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
]);

export const PROVIDER_TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cfg', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.ini', '.ipynb',
  '.java', '.js', '.json', '.jsx', '.log', '.md', '.mjs', '.py', '.r', '.rb', '.rs', '.sh', '.sql',
  '.svg', '.swift', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml', '.zsh'
]);

export function isSupportedProviderImage(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

export function isSupportedProviderImageAttachment(name: string, mimeType: string): boolean {
  return isSupportedProviderImage(mimeType) || IMAGE_EXTENSIONS.has(extensionOf(name));
}

export function isProviderOfficeDocument(name: string): boolean {
  return OFFICE_EXTENSIONS.has(extensionOf(name));
}

export function isSupportedProviderText(name: string, mimeType: string): boolean {
  const mime = mimeType.toLowerCase();
  return mime.startsWith('text/') || [
    'application/json', 'application/javascript', 'application/xml', 'application/x-yaml', 'application/toml'
  ].includes(mime) || PROVIDER_TEXT_EXTENSIONS.has(extensionOf(name));
}

export function isDeepseekDirectUpload(name: string, mimeType: string): boolean {
  const extension = extensionOf(name);
  return mimeType.toLowerCase() === 'application/pdf' || extension === '.pdf' ||
    isSupportedProviderImageAttachment(name, mimeType) || isProviderOfficeDocument(name);
}

export function isDeepseekSupportedAttachment(name: string, mimeType: string): boolean {
  return isDeepseekDirectUpload(name, mimeType) || isSupportedProviderText(name, mimeType);
}

export const DEEPSEEK_ATTACHMENT_FORMATS_MESSAGE =
  'Unsupported file format. DeepSeek accepts PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, images, text, and code files.';
