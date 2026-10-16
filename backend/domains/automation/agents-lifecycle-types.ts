import type { AgentMessage } from "../../../contracts/session.js";
import type { agentsLifecycleRuntime } from "./agents.js";

export interface AliveResult {
  agentId: string;
  revived: boolean;
  report: AgentMessage | null;
}

export type AgentLifecycleRuntime = typeof agentsLifecycleRuntime;
