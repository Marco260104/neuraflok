/** The broker: what a run is, who may act in it, and what happens to messages. Identity itself — which conversation is which agent, and what a code may and may not do — lives in swarm.test.ts. This file is about everything downstream of that answer: creating a run atomically, the star topology, at-least-once delivery, terminal states, restart, and the shape of all of it over the actual MCP endpoint. */

import { vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

import './agents/context.js';
import './agents/identity-and-setup.test.js';
import './agents/message-delivery-and-worker-states.test.js';
import './agents/worker-sleep.test.js';
import './agents/restart.test.js';
import './agents/mcp-identity-and-discovery.test.js';
import './agents/mcp-recovery-and-durability.test.js';
import './agents/mcp-messaging-and-cross-run.test.js';
import './agents/independent-prime-families.test.js';
