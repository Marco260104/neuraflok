export interface PendingHelperRequest {
  resolve: (value: Record<string, any>) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export type ExpectedHelper = { generation: number; code: 'STALE_FRAME' | 'STALE_REF' };
