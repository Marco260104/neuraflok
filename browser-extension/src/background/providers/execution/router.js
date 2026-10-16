import { createDeepseekPageExecutor } from './deepseek.js';
import { createProviderPageState } from '../delivery-ledger.js';
import { createWebProviderPageExecutor } from './web.js';

export function createProviderPageExecutor(dependencies) {
  const state = createProviderPageState(dependencies.chrome);
  const deepseek = createDeepseekPageExecutor({ ...dependencies, state });
  const web = createWebProviderPageExecutor({ ...dependencies, state });
  return {
    inspect(offer, background) {
      if (offer?.provider === 'deepseek') return deepseek.inspect(offer, background);
      return web.inspect(offer, background);
    },
    busy() {
      return deepseek.busy() || web.busy();
    }
  };
}
