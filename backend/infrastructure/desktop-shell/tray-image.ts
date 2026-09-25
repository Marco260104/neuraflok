import path from 'node:path';
import sharp from 'sharp';

export interface TrayRepresentation {
  scaleFactor: 1 | 2;
  png: Buffer;
}

export interface TrayImageSpec {
  template: boolean;
  representations: readonly [TrayRepresentation, TrayRepresentation];
}

const LOGICAL_SIZE = 16;
const NEURAFLOK_TRAY_GUID = '94c2f68a-9db9-4c4b-b277-ecb3564530db';

async function transparentMark(mark: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(mark, { limitInputPixels: 4_194_304 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    const luminance = (data[index]! + data[index + 1]! + data[index + 2]!) / 3;
    if (luminance < 18) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 0;
    } else if (luminance < 56) {
      data[index + 3] = Math.round(data[index + 3]! * ((luminance - 18) / 38));
    }
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function renderRepresentation(mark: Buffer, scaleFactor: 1 | 2): Promise<TrayRepresentation> {
  const size = LOGICAL_SIZE * scaleFactor;
  const punched = await transparentMark(mark);
  const png = await sharp(punched, { limitInputPixels: 4_194_304 })
    .trim()
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return { scaleFactor, png };
}

export async function trayImageSpec(
  platform: NodeJS.Platform,
  _running: boolean,
  mark: Buffer
): Promise<TrayImageSpec> {
  const [one, two] = await Promise.all([
    renderRepresentation(mark, 1),
    renderRepresentation(mark, 2)
  ]);
  return { template: platform === 'darwin', representations: [one, two] };
}

export function trayMarkPath(packaged: boolean, appPath: string, resourcesPath: string): string {
  const root = packaged ? resourcesPath : appPath;
  return path.join(root, 'brand', 'LogotipoSN.png');
}

export function trayGuidForPlatform(platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === 'darwin' ? NEURAFLOK_TRAY_GUID : undefined;
}

export function trayGuidArgsForPlatform(platform: NodeJS.Platform = process.platform): [] | [string] {
  const guid = trayGuidForPlatform(platform);
  return guid ? [guid] : [];
}
