// Owns the shared terminal process manager and its output budgets.

import type { TruncationPolicy } from './output-bounds.js';
import {
  DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  UNIFIED_EXEC_OUTPUT_MAX_TOKENS
} from './unified-exec-constants.js';
import { UnifiedExecProcessManager } from './unified-exec.js';

export const unifiedExecManager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);

// Caps command output when the caller does not provide a separate budget.
export const DEFAULT_TRUNCATION_POLICY: TruncationPolicy = { kind: 'tokens', tokens: DEFAULT_MAX_OUTPUT_TOKENS };

// Keeps the request safety ceiling aligned with the bounded process collector.
export const EXEC_OUTPUT_CEILING_POLICY: TruncationPolicy = {
  kind: 'tokens',
  tokens: UNIFIED_EXEC_OUTPUT_MAX_TOKENS
};
