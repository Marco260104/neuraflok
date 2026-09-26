import { ComputerError, type ActionRoute } from './errors.js';

export function completedHelperRoutes(reply: Record<string, any>, completed: number): ActionRoute[] | undefined {
  const raw = reply['routes'];
  if (!Number.isInteger(completed) || completed < 0 || !Array.isArray(raw) || raw.length !== completed) return undefined;
  const routes = raw.map(String);
  if (!routes.every(route => route === 'uia' || route === 'sendinput' || route === 'focus' || route === 'shell')) return undefined;
  return routes as ActionRoute[];
}

export function protocolFailure(reply: Record<string, any>): ComputerError | null {
  if (reply['ok'] !== false) return null;
  const completed = Number(reply['completed_count']);
  const failed = Number(reply['failed_index']);
  const completedRoutes = completedHelperRoutes(reply, completed);
  return new ComputerError(
    `${String(reply['error_code'] ?? 'HELPER_ERROR')}: ${String(reply['message'] ?? 'Desktop helper failed')}`,
    {
      ...(Number.isInteger(completed) && completed >= 0 ? { completedCount: completed } : {}),
      ...(Number.isInteger(failed) && failed >= 0 ? { failedIndex: failed } : {}),
      ...(completedRoutes ? { completedRoutes } : {})
    }
  );
}
