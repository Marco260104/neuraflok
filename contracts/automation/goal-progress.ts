export type GoalWaitReason = 'tools' | 'workers' | 'quiet' | 'silence' | 'listening' | 'native-busy' | 'settling' | 'closed';

export interface GoalWait {
  reason: GoalWaitReason;
  until?: number;
}
