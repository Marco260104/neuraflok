const reserved = new Set<string>();
const shortcutGroups: Array<{ modifier: string; base: string[]; shift: string[]; alt?: string[] }> = [
  { modifier: 'ctrl', base: ['w', 'f4', 't', 'n', 'tab', 'pageup', 'pagedown'], shift: ['w', 't', 'n', 'tab', 'q'] },
  { modifier: 'cmd', base: ['w', 'q', 'h', 't', 'n', '[', ']'], shift: ['w', 't', 'n', '[', ']'], alt: ['h', 'left', 'right'] }
];

for (const group of shortcutGroups) {
  for (const key of group.base) reserved.add(`${group.modifier}+${key}`);
  for (const key of group.shift) reserved.add(`${group.modifier}+shift+${key}`);
  for (const key of group.alt ?? []) reserved.add(`${group.modifier}+alt+${key}`);
  for (let tab = 1; tab <= 9; tab += 1) reserved.add(`${group.modifier}+${tab}`);
}

for (const shortcut of ['alt+f4', 'alt+left', 'alt+right', 'alt+home']) reserved.add(shortcut);

export function isReservedBrowserChord(chord: string): boolean {
  return reserved.has(chord);
}
