import type { SessionEvent, SessionSummary, SwarmState } from '../../../contracts/session.js';
import type { GoalWait } from '../../../contracts/automation/goal-progress.js';
import type { AppState } from '../../../contracts/types.js';
import type { Badge } from './chat-session-row.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { PendingNewProjectInput } from './chat-warmup-inputs.js';

export interface ChatProgressRuntime {
  api: Pick<typeof window.api, 'runningProcesses' | 'runningTools' | 'stopProcess'>;
  selectedId: string | null;
  selectedProjectId: string | null;
  pendingNewInput: PendingNewProjectInput | null;
  selectionGeneration: number;
  controlledSessionId: string | null;
  controlledSelection: number;
  controlledTurnId: string | null;
  goalWaitView: GoalWait | null;
  events: SessionEvent[];
  startingInputs: Map<string, InputEntry>;
  pendingComposerInputs: InputEntry[];
  sessions: SessionSummary[];
  detailFor: string | null;
  swarm: SwarmState | null;
  durationTimer: number | undefined;
  visible: boolean;
  badgeKey: string;
  state: () => AppState | null;
  sessionBadges: (summary: SessionSummary) => Badge[];
  paintSessions: () => void;
  paintRecoveryStatus: () => boolean;
  paintGoalProgress: () => void;
}
