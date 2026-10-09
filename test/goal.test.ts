/** The goal loop: the second model that stands in for the user. The three things worth pinning here are the three that cost something when they go wrong. The *context* is a privacy boundary — what leaves this machine is the conversation and nothing else, and a regression there is silent. `NO_REPLY` is the loop's stopping condition, and a loop that cannot stop types into somebody's chat forever. And one draft per generation is what stands between a retried request and two messages in one chat. The page's half — deciding that a turn is *really* over — is tested in test/content-script.test.ts against the real content script. */

import './goal/context.js';
import './goal/goal-settings-and-delivery.test.js';
import './goal/goal-privacy-context.test.js';
import './goal/goal-planner-reasoning.test.js';
import './goal/goal-reply-lifecycle.test.js';
import './goal/goal-generation-deduplication.test.js';
import './goal/openrouter-errors.test.js';
import './goal/goal-model-catalogue.test.js';
import './goal/goal-reply-preservation.test.js';
import './goal/goal-session-loop.test.js';
import './goal/goal-opening.test.js';
import './goal/goal-loop-policy.test.js';
import './goal/goal-streaming-and-finish.test.js';
import './goal/custom-openai-provider.test.js';
