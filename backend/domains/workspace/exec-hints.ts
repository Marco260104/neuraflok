// Applies bounded command repairs for provider-issued shell commands.

export { bindBundledRipgrep } from './exec-hints/ripgrep-binding.js';
export { normalizePowerShellOperators } from './exec-hints/powershell-operators.js';
export { normalizeShellCommand } from './exec-hints/powershell-command-normalizer.js';
export { repairPowerShellQuoting } from './exec-hints/powershell-quoting.js';
export type { DirectoryLister } from './exec-hints/powershell-globs.js';
export type { NormalizedCommand } from './exec-hints/types.js';
export { RG_BOOLEAN_FLAGS, RG_OPTION_TABLE_VERSION, RG_VALUE_FLAGS, statusDeterminingProgram } from './exec-command-parser.js';
export { benignExitNote, nonZeroExitIsBenign } from './exec-exit-analysis.js';
export { execRecoveryHints, withExecNotes } from './exec-recovery-hints.js';
