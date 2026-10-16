import type { GoalModel } from "../../../contracts/automation/goal-model-reasoning.js";
import type { Capabilities, Config } from "../../../contracts/types.js";
import type { SessionEvent, SessionSummary, TokenPressure } from "../../../contracts/session.js";

export interface SettingsPatch {
  capabilities: Capabilities;
  readOnly: boolean;
  commandAllowlist: Config["commandAllowlist"];
  ui: Config["ui"];
  sessions: Config["sessions"];
  compaction: Config["compaction"];
  multiAgent: Config["multiAgent"];
  goal: Config["goal"];
  providerTools: Config["providerTools"];
  controlApi?: Config["controlApi"];
}

export interface GoalModelPage {
  models: GoalModel[];
  total: number;
  selectedModel?: GoalModel;
}

export interface SessionList {
  sessions: SessionSummary[];
  activeId: string | null;
  blocked: string[];
  trusted?: string[];
  pressure: Array<TokenPressure & { id: string }>;
  total: number;
  nextCursor: SessionListCursor | null;
}

export interface SessionListCursor {
  updatedAt: number;
  id: string;
}

export interface SessionDetail {
  summary: SessionSummary | null;
  events: SessionEvent[];
  total: number;
  nextFrom: number;
}
