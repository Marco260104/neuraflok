const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'cmd']);
const MODIFIER_ORDER = ['cmd', 'ctrl', 'alt', 'shift'];
const KEY_ALIAS_GROUPS: Record<string, readonly string[]> = {
  ctrl: ['control', 'control_l', 'control_r', 'ctrl_l', 'ctrl_r'],
  shift: ['shift_l', 'shift_r'],
  alt: ['alt_l', 'alt_r', 'option'],
  cmd: ['super_l', 'super_r', 'meta_l', 'meta_r', 'command', 'meta', 'super', 'win', 'windows'],
  pageup: ['pgup', 'page_up', 'prior', 'kp_prior', 'numpad_prior'],
  pagedown: ['pgdn', 'page_down', 'next', 'kp_next', 'numpad_next'],
  left: ['kp_left', 'numpad_left', 'arrowleft'],
  right: ['kp_right', 'numpad_right', 'arrowright'],
  home: ['kp_home', 'numpad_home'],
  '[': ['bracketleft'],
  ']': ['bracketright']
};
const KEY_ALIASES = new Map(Object.entries(KEY_ALIAS_GROUPS).flatMap(([canonical, aliases]) =>
  aliases.map((alias) => [alias, canonical] as const)));

export function normalizeKeyChord(keys: readonly string[]): string | null {
  const modifiers = new Set<string>();
  const pressed: string[] = [];
  for (const input of keys) {
    const token = input.trim().toLowerCase();
    const key = KEY_ALIASES.get(token) ?? token;
    if (!key) continue;
    if (MODIFIERS.has(key)) modifiers.add(key);
    else pressed.push(key);
  }
  if (pressed.length !== 1) return null;
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), pressed[0]].join('+');
}
