export interface BrowserWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserWindowBounds {
  width: number;
  height: number;
  left?: number;
  top?: number;
}

export type WorkAreaSource = () => BrowserWorkArea | undefined;
