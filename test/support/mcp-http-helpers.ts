import type { ToolRequestTiming } from '../../backend/infrastructure/tool-gateway/request-context.js';

export function requestIdFromHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value) && value.length !== 1) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const id = raw.split('/')[0]!.trim();
  return id.length > 0 && id.length <= 100 && /^[a-z0-9_-]+$/i.test(id) ? id : null;
}

export function formatToolRequestTiming(timing: ToolRequestTiming): string {
  if (!timing.calls) return '';
  const ms = (value: number) => Math.max(0, Math.round(value));
  return ` calls=${timing.calls} ingress_ms=${ms((timing.dispatchedAt ?? timing.startedAt) - timing.startedAt)}` +
    Object.entries(timing.phases).map(([phase, value]) => ` ${phase}_ms=${ms(value)}`).join('') +
    ` response_tail_ms=${timing.completedAt === null ? 'pending' : ms(performance.now() - timing.completedAt)}`;
}
