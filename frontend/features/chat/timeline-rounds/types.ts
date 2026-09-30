import type { SessionEvent } from '../../../../contracts/session.js';

export interface FlowRow {
  key: string;
  event?: SessionEvent;
  tail?: boolean;
}

export type RoundPart =
  | { kind: 'row'; key: string }
  | { kind: 'say'; key: string; rowKey: string }
  | { kind: 'work'; key: string; rows: string[]; recap: string | null; live: boolean; turnId?: string };
