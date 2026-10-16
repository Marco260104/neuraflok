import { WINDOW_ID_NONE, type ModelEvent, type TabRecord, type WindowRecord } from './model-contracts.js';

export class TabModelState {
  readonly windows = new Map<number, WindowRecord>();
  readonly tabs = new Map<number, TabRecord>();
  nextWindowId = 1;
  focusedWindowId = WINDOW_ID_NONE;
  lastFocusedWindowId = WINDOW_ID_NONE;

  constructor(readonly emit: (event: ModelEvent) => void, readonly now: () => number) {}
}
