/** Reading a model-issued shell command well enough to stop punishing it for Windows. These are regressions for a measured problem, not hygiene. Across the 50 most recent recorded sessions, 79 of 1,175 tool calls were stored as errors — and only 16 of those were a build or test that genuinely failed. Nine were ripgrep reporting "no matches" or being cut short by `Select-Object -First`, both of which exit 1 by design; five were PowerShell handing ripgrep an unexpanded `*`; seven were git run in a folder with no `.git`. The error count had stopped meaning "something went wrong". The dangerous failure mode for this file is the opposite of the one it fixes: a rule that is too eager launders real failures into successes, or rewrites a command into one that silently searches the wrong place. Every test below that asserts a *negative* is guarding that edge, and matters more than the positives. */

import './exec-hints/exit-code-semantics.test.js';
import './exec-hints/powershell-and-globs.test.js';
import './exec-hints/recovery-and-option-hints.test.js';
import './exec-hints/quoting-and-benign-exit-hints.test.js';
import './exec-hints/pipelines-and-search-paths.test.js';
import './exec-hints/context.js';
