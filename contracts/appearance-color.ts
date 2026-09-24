type Rgb = readonly [red: number, green: number, blue: number];

const HEX_COLOR = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i;

function parseColor(value: string): Rgb {
  const parts = HEX_COLOR.exec(value);
  if (!parts) throw new Error('Expected a six-digit hexadecimal color.');
  return [Number.parseInt(parts[1]!, 16), Number.parseInt(parts[2]!, 16), Number.parseInt(parts[3]!, 16)];
}

function formatColor([red, green, blue]: Rgb): string {
  return `#${[red, green, blue].map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function mixColor(first: string, second: string, amount: number): string {
  const from = parseColor(first);
  const to = parseColor(second);
  const weight = clampUnit(amount);
  return formatColor([
    from[0] + (to[0] - from[0]) * weight,
    from[1] + (to[1] - from[1]) * weight,
    from[2] + (to[2] - from[2]) * weight
  ]);
}

function linearChannel(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function luminance(color: string): number {
  const [red, green, blue] = parseColor(color);
  return linearChannel(red) * 0.2126 + linearChannel(green) * 0.7152 + linearChannel(blue) * 0.0722;
}

export function contrastRatio(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function readableInk(background: string): string {
  const white = contrastRatio(background, '#ffffff');
  const black = contrastRatio(background, '#000000');
  return white > black ? '#ffffff' : '#000000';
}

export function readableTint(color: string, background: string, minimumRatio: number): string {
  const target = readableInk(background);
  if (contrastRatio(color, background) >= minimumRatio) return formatColor(parseColor(color));
  if (contrastRatio(target, background) < minimumRatio) return target;

  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 16; iteration++) {
    const midpoint = (lower + upper) / 2;
    if (contrastRatio(mixColor(color, target, midpoint), background) >= minimumRatio) upper = midpoint;
    else lower = midpoint;
  }
  return mixColor(color, target, upper);
}
