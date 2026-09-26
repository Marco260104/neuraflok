export type ActionRoute = 'uia' | 'sendinput' | 'focus' | 'shell' | 'local';

export interface ComputerErrorProgress {
  completedCount?: number;
  failedIndex?: number;
  completedRoutes?: ActionRoute[];
}

function normalizeProgress(details: ComputerErrorProgress) {
  return {
    completedCount: details.completedCount ?? null,
    failedIndex: details.failedIndex ?? null,
    completedRoutes: details.completedRoutes?.slice() ?? null
  };
}

export class ComputerError extends Error {
  readonly completedCount!: number | null;
  readonly failedIndex!: number | null;
  readonly completedRoutes!: ActionRoute[] | null;

  constructor(message: string, details: ComputerErrorProgress = {}) {
    super(message);
    Object.assign(this, normalizeProgress(details));
  }
}
