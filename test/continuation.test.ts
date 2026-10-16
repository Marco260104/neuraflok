/** The Compact & Resume transaction: moving one durable local session from chat A to chat B. Every test here is about the failure half of that move rather than the happy path. The invariant the whole design exists to protect is that a commit either lands completely or leaves the session attached to chat A — never a session on disk in B with its swarm, its workspace or its recorded history still in A. So these drive the races directly: two claimants, a claim arriving mid-commit, a sweep firing mid-commit, an abort mid-commit, a durable write that fails, and a handover deadline crossed while the write is in flight. */

import './continuation/context.js';
import './continuation/01-brief-capture.test.js';
import './continuation/02-atomic-commit.test.js';
import './continuation/03-source-ownership.test.js';
import './continuation/04-destination-resume.test.js';
import './continuation/05-recovery-races.test.js';
import './continuation/06-expiration-and-cleanup.test.js';
import './continuation/07-identity-recovery.test.js';
import './continuation/08-send-authority.test.js';
import './continuation/09-finalization.test.js';
