// Generate desktop and extension icons from the supplied NEURAFLOK mark.

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Windows 11 extra-large desktop and shortcut tiles use 256px; smaller sizes keep Explorer and the taskbar sharp.
const ICO_SIZES = [256, 128, 64, 48, 32, 16];
const EXTENSION_SIZES = [128, 48, 32, 16];
const SOURCE_PATH = path.join(root, './brand', 'LogotipoSN.png');

// Decode and validate the source PNG.

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

// Decode the controlled RGBA source PNG without adding a native image dependency.
function decodeSourcePng(encoded) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (encoded.length < signature.length || !encoded.subarray(0, 8).equals(signature)) {
    throw new Error('brand/LogotipoSN.png is not a PNG');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat = [];
  for (let offset = 8; offset + 12 <= encoded.length; ) {
    const length = encoded.readUInt32BE(offset);
    const type = encoded.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > encoded.length) throw new Error('truncated app icon PNG');
    if (type === 'IHDR') {
      width = encoded.readUInt32BE(start);
      height = encoded.readUInt32BE(start + 4);
      bitDepth = encoded[start + 8];
      colourType = encoded[start + 9];
      interlace = encoded[start + 12];
    } else if (type === 'IDAT') {
      idat.push(encoded.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }

  if (width < 1 || height < 1 || bitDepth !== 8 || (colourType !== 2 && colourType !== 6) || interlace !== 0 || idat.length === 0) {
    throw new Error('app icon source must be a non-interlaced 8-bit RGB or RGBA PNG');
  }

  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  if (inflated.length !== height * (stride + 1)) throw new Error('unexpected app icon PNG data length');
  const raw = Buffer.alloc(height * stride);
  let input = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[input++];
    if (filter > 4) throw new Error(`unsupported app icon PNG filter ${filter}`);
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? raw[row + x - channels] : 0;
      const up = y > 0 ? raw[row + x - stride] : 0;
      const upperLeft = y > 0 && x >= channels ? raw[row + x - stride - channels] : 0;
      let value = inflated[input++];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) value += paeth(left, up, upperLeft);
      raw[row + x] = value & 0xff;
    }
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0, o = 0; i < width * height; i++) {
    const src = i * channels;
    pixels[o++] = raw[src];
    pixels[o++] = raw[src + 1];
    pixels[o++] = raw[src + 2];
    pixels[o++] = channels === 4 ? raw[src + 3] : 255;
  }
  return { width, height, pixels };
}

const source = decodeSourcePng(readFileSync(SOURCE_PATH));

// LogotipoSN is authored on a black square with generous whitespace. Trim that
// whitespace around the bright mark so Explorer, the taskbar, and small tiles
// do not render the brand as a tiny glyph. Keep a quiet 6% inset around it.
function markBounds(image) {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const at = (y * image.width + x) * 4;
      const visible = image.pixels[at + 3] > 16 &&
        Math.max(image.pixels[at], image.pixels[at + 1], image.pixels[at + 2]) > 32;
      if (!visible) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error('brand/LogotipoSN.png has no visible mark');
  const width = right - left + 1;
  const height = bottom - top + 1;
  const side = Math.max(width, height) * 1.12;
  const centerX = (left + right + 1) / 2;
  const centerY = (top + bottom + 1) / 2;
  return { left: centerX - side / 2, top: centerY - side / 2, side };
}

const crop = markBounds(source);

// Area-resample the supplied mark while preserving its original colors and clean edges.
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    const y0 = crop.top + (py * crop.side) / size;
    const y1 = crop.top + ((py + 1) * crop.side) / size;
    for (let px = 0; px < size; px++) {
      const x0 = crop.left + (px * crop.side) / size;
      const x1 = crop.left + ((px + 1) * crop.side) / size;
      let alphaWeight = 0;
      let totalWeight = 0;
      const premultiplied = [0, 0, 0];
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        if (sy < 0 || sy >= source.height) continue;
        const yWeight = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          if (sx < 0 || sx >= source.width) continue;
          const xWeight = Math.min(x1, sx + 1) - Math.max(x0, sx);
          const weight = Math.max(0, xWeight) * Math.max(0, yWeight);
          if (weight === 0) continue;
          const sourceIndex = sy * source.width + sx;
          const at = sourceIndex * 4;
          const alpha = source.pixels[at + 3] / 255;
          for (let channel = 0; channel < 3; channel++) {
            premultiplied[channel] += source.pixels[at + channel] * alpha * weight;
          }
          alphaWeight += alpha * weight;
          totalWeight += weight;
        }
      }
      const output = (py * size + px) * 4;
      if (alphaWeight > 0) {
        for (let channel = 0; channel < 3; channel++) {
          pixels[output + channel] = Math.round(premultiplied[channel] / alphaWeight);
        }
      }
      pixels[output + 3] = Math.round((alphaWeight / Math.max(totalWeight, Number.EPSILON)) * 255);
    }
  }
  return pixels;
}

// Encode PNG output.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// Encode Windows ICO output. Explorer shortcuts need BMP for 16–128; Chromium/taskbar can read PNG 256.

function encodeBmpIcon(size, pixels) {
  const andRowBytes = Math.floor((size + 31) / 32) * 4;
  const xorSize = size * size * 4;
  const andSize = andRowBytes * size;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(xorSize + andSize, 20);
  const xor = Buffer.alloc(xorSize);
  const and = Buffer.alloc(andSize);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const src = (srcY * size + x) * 4;
      const dst = (y * size + x) * 4;
      xor[dst] = pixels[src + 2];
      xor[dst + 1] = pixels[src + 1];
      xor[dst + 2] = pixels[src];
      xor[dst + 3] = pixels[src + 3];
      if (pixels[src + 3] < 128) {
        and[y * andRowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return Buffer.concat([header, xor, and]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, payload } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(payload.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += payload.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.payload)]);
}

// Write the desktop and extension icon files.

const pixelCache = new Map();
const pngCache = new Map();
const pixelsFor = (size) => {
  if (!pixelCache.has(size)) pixelCache.set(size, render(size));
  return pixelCache.get(size);
};
const pngFor = (size) => {
  if (!pngCache.has(size)) pngCache.set(size, encodePng(size, pixelsFor(size)));
  return pngCache.get(size);
};

mkdirSync(path.join(root, 'build'), { recursive: true });
const icoImages = ICO_SIZES.map((size) => ({
  size,
  payload: size >= 256 ? pngFor(size) : encodeBmpIcon(size, pixelsFor(size))
}));
writeFileSync(path.join(root, 'build', 'icon.ico'), encodeIco(icoImages));
writeFileSync(path.join(root, 'build', 'icon.png'), pngFor(1024));
writeFileSync(path.join(root, 'build', 'icon-preview.png'), pngFor(256));
writeFileSync(path.join(root, 'build', 'runtime-icon.png'), pngFor(256));
console.log(
  `Wrote build/icon.ico (${ICO_SIZES.join(', ')}), build/icon.png, build/icon-preview.png and build/runtime-icon.png`
);

const iconsDir = path.join(root, './browser-extension', 'assets', 'icons');
mkdirSync(iconsDir, { recursive: true });
for (const size of EXTENSION_SIZES) {
  writeFileSync(path.join(iconsDir, `icon${size}.png`), pngFor(size));
}
console.log(`Wrote browser-extension/assets/icons/icon{${EXTENSION_SIZES.join(',')}}.png`);
