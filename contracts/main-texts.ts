/** English source for tray menus, Session finish controls, and the notice shown when NEURAFLOK hides to the tray. The renderer translates this allowlist because the main process has no interface catalogs. */
export const MAIN_TEXTS = [
  'Open',
  'Show browser',
  'Hide browser',
  'Connect',
  'Disconnect',
  'Quit',
  'Connected',
  'No internet',
  'Not connected',
  'Astra is wrapping up',
  'Send an automatic Goal or write your next instruction.',
  'Send Automatic Goal',
  'Write Directly',
  'The NEURAFLOK browser is still running',
  'Your chats keep going. Choose Show browser in the tray icon’s menu to bring it back.',
  'Your chats keep going. Choose Show browser in the menu bar icon’s menu to bring it back.'
] as const;

export type MainText = typeof MAIN_TEXTS[number];

export function isMainText(value: string): value is MainText {
  return (MAIN_TEXTS as readonly string[]).includes(value);
}
