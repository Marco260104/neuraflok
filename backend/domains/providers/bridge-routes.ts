import type http from 'node:http';
import { reportProviderPageProgress, settleProviderPage } from './provider-page.js';

type ReadBody = (req: http.IncomingMessage) => Promise<unknown>;
type SendJson = (res: http.ServerResponse, status: number, body: unknown, origin: string | null) => void;
type SendTooLarge = (res: http.ServerResponse, origin: string | null) => void;

export interface ProviderPageRouteSupport {
  readBody: ReadBody;
  json: SendJson;
  tooLarge: SendTooLarge;
}

export async function handleProviderPageRoute(
  route: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  origin: string | null,
  integratedHost: boolean,
  support: ProviderPageRouteSupport
): Promise<boolean> {
  if (req.method !== 'POST' || (route !== '/provider/page' && route !== '/provider/page/progress')) return false;
  if (!integratedHost) {
    support.json(res, 200, { ok: false }, origin);
    return true;
  }

  let body: unknown;
  try { body = await support.readBody(req); }
  catch (error) {
    if ((error as Error).message === 'body_too_large') support.tooLarge(res, origin);
    else support.json(res, 400, { error: 'bad_request' }, origin);
    return true;
  }
  if (!body || typeof body !== 'object' || typeof (body as { id?: unknown }).id !== 'string') {
    support.json(res, 400, { error: 'invalid_provider_page' }, origin);
    return true;
  }

  const accepted = route === '/provider/page/progress'
    ? reportProviderPageProgress(body as Record<string, unknown>)
    : settleProviderPage(body as Record<string, unknown>);
  support.json(res, 200, { ok: accepted }, origin);
  return true;
}
