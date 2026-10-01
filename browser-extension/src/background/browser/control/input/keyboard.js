export function keyEvents(chord, error) {
  if (typeof chord !== 'string' || !chord) error('BROWSER_KEY_REQUIRED');
  const parts = chord.split('+');
  let modifiers = 0;
  const modifierBits = { control: 2, ctrl: 2, shift: 8, alt: 1, meta: 4, command: 4 };
  for (const name of parts.slice(0, -1)) {
    const bit = modifierBits[name.toLowerCase()];
    if (!bit) error('BROWSER_KEY_INVALID: use Control/Shift/Alt/Meta plus one key.');
    modifiers |= bit;
  }
  const supplied = parts.at(-1);
  const specialKeys = {
    Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
    ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40],
    Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Space: ['Space', 32]
  };
  const aliases = { return: 'Enter', esc: 'Escape', spacebar: 'Space', left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' };
  const namedKey = Object.keys(specialKeys).find(name => name.toLowerCase() === supplied.toLowerCase());
  const key = namedKey || aliases[supplied.toLowerCase()] || supplied;
  const special = specialKeys[key];
  if (!special && key.length !== 1) {
    error('BROWSER_KEY_INVALID: use a character, Enter, Tab, Escape, Backspace, Delete, ArrowLeft/Right/Up/Down, Home, End, PageUp/Down or Space, optionally prefixed by Control/Shift/Alt/Meta. Named keys are case-insensitive.');
  }
  const actual = key === 'Space' ? ' ' : key;
  const code = special?.[0] || (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : '');
  const virtualKeyCode = special?.[1] || key.toUpperCase().charCodeAt(0);
  return {
    key: actual,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    modifiers,
    ...(!(modifiers & 7) && (actual.length === 1 || key === 'Enter') ? { text: key === 'Enter' ? '\r' : actual } : {})
  };
}
