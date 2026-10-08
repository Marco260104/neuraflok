/** Exercises the MCP tool protocol over loopback HTTP, including request limits, tool-surface boundaries, and shutdown behavior. */

import './mcp/01-endpoint-hardening.test.js';
import './mcp/02-surface-boundaries.test.js';
import './mcp/03-2025-era-clients.test.js';
import './mcp/04-2026-07-28-clients.test.js';
import './mcp/05-capability-gating.test.js';
import './mcp/06-desktop-capabilities.test.js';
import './mcp/07-tool-annotations.test.js';
import './mcp/08-sandbox-enforcement-through-the-tool-layer.test.js';
import './mcp/09-bounded-output.test.js';
import './mcp/10-apply-patch.test.js';
import './mcp/11-exec-command-and-write-stdin.test.js';
import './mcp/12-agent-maintained-plans-over-mcp.test.js';
import './mcp/13-exec-sessions-belong-to-the-chat-that-opened-them.test.js';
import './mcp/14-the-outcome-a-shell-command-is-recorded-with.test.js';
import './mcp/15-blocked-chats.test.js';
