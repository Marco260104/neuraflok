const UTF8_TEXT_STREAM = '[System.Text.UTF8Encoding]::new($false)';
const PROCESS_PREAMBLE = [
  `[Console]::OutputEncoding = ${UTF8_TEXT_STREAM}`,
  `$OutputEncoding = ${UTF8_TEXT_STREAM}`,
  "$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'",
  "$ProgressPreference = 'SilentlyContinue'"
].join('; ');

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
};

export function encodePowerShellScript(script: string): string {
  const source = `${PROCESS_PREAMBLE}; ${script}`;
  return Buffer.from(source, 'utf16le').toString('base64');
}

function decodeXmlText(text: string): string {
  return text.replace(/_x([0-9a-f]{4})_|&(amp|lt|gt|quot|apos);/gi, (token, unit: string | undefined, entity: string | undefined) => {
    if (unit) return String.fromCharCode(Number.parseInt(unit, 16));
    return XML_ENTITIES[(entity ?? '').toLowerCase()] ?? token;
  });
}

function clixmlMessages(xml: string): string[] {
  return [...xml.matchAll(/<S\b(?=[^>]*\bS=["'](?:Error|Warning)["'])[^>]*>([\s\S]*?)<\/S>/gi)]
    .map(match => decodeXmlText(match[1] ?? '').trim())
    .filter(Boolean);
}

export function cleanPowerShellStderr(stderr: string): string {
  const marker = '#< CLIXML';
  const start = stderr.indexOf(marker);
  if (start === -1) return stderr.trim();

  const prefix = stderr.slice(0, start).trim();
  const messages = clixmlMessages(stderr.slice(start + marker.length));
  return messages.length ? [prefix, ...messages].filter(Boolean).join('\n').trim() : stderr.trim();
}
