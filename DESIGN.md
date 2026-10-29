# Design

register: product

## Scene

A developer at a desk lamp late at night, switching between local files and signed-in AI browser sessions. The workspace recedes like a well-made editor. One cyan signal marks send, selection, and the live connection.

## Color

Restrained. Cool zinc neutrals tinted toward cyan (hue ~230). One accent, used for primary actions, the selected session, and focus. Green is live status only. Red is error only.

| Token | Light | Dark |
| --- | --- | --- |
| Page | `#eef2f5` | `#141a20` |
| Sidebar | `#e1e7ec` | `#0c1014` |
| Accent | `#0d7480` | `#3ecad6` |

The sidebar is darker than the canvas in dark mode so the chat surface reads as the work area.

## Radius

Concentric. Inner controls use `--r-sm` (8px). A padded parent adds its padding: composer outer is `--r-sm + 12px`. Pills are reserved for true capsules (connection, skill chips).

`--r-xs: 6px` `--r-sm: 8px` `--r-md: 10px` `--r-lg: 14px` `--r-xl: 18px`

## Elevation

Borders for structure, Better UI shadow rings for depth. Light: three-layer `--shadow-border`. Dark: `0 0 0 1px oklch(1 0 0 / 0.08)`. Forced-colors keeps `border: 1px solid transparent` under every ring.

## Motion

`--ease-out: cubic-bezier(0.2, 0, 0, 1)`. Press scales to `0.96` over `150ms`. Infrequent enters: opacity + 12px translateY + 4px blur over `300ms`, stagger `100ms`. Exits `150ms`. Hover styles only under `(hover: hover)`. Theme swaps suppress transitions. Reduced motion keeps an opacity cross-fade.

## Typography

System UI stack. Product scale, not display. Body ~13px. Welcome title 15px / 550. Tabular numbers on meters and timestamps.
