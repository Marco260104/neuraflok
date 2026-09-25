import type { CommandRouteRuntime } from './routes-runtime.js';

export function createRouteResponders(runtime: CommandRouteRuntime, origin: string | null) {
  return {
    respond(response: Parameters<CommandRouteRuntime['json']>[0], status: number, body: unknown, responseOrigin: string | null = origin): true {
      runtime.json(response, status, body, responseOrigin);
      return true;
    },
    respondTooLarge(response: Parameters<CommandRouteRuntime['tooLarge']>[0], responseOrigin: string | null = origin): true {
      runtime.tooLarge(response, responseOrigin);
      return true;
    }
  };
}
