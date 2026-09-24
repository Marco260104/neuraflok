export type IntegratedBrowserToolbarAction = 'activate' | 'close' | 'reload' | 'stop' | 'back' | 'forward' | 'extension';

export interface IntegratedBrowserToolbarTab {
  id: number;
  title: string;
  url: string;
  favicon: string | null;
  active: boolean;
  loading: boolean;
  working: boolean;
}

export interface IntegratedBrowserToolbarState {
  tabs: IntegratedBrowserToolbarTab[];
  navigation: { back: boolean; forward: boolean; loading: boolean };
  connected: boolean | null;
  companionIcon: string | null;
  tokens: Record<string, string>;
  insets: { left: number; right: number };
}

export interface IntegratedBrowserToolbarApi {
  act(action: IntegratedBrowserToolbarAction, tabId?: number): void;
  onState(listener: (state: IntegratedBrowserToolbarState) => void): void;
}
