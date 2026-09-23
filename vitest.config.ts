import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Real filesystem, child processes, and HTTP need a 30-second test and hook timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // CI retries timing-sensitive tests and reports every test that needs a retry.
    retry: Number(process.env.NEURAFLOK_TEST_RETRY) || 0,
    reporters: process.env.GITHUB_ACTIONS ? ['default', './scripts/flaky-reporter.mjs'] : ['default'],
    env: {
      // Keep tests away from the installed bridge range.
      NEURAFLOK_BRIDGE_PORTS: '0',
      // Shorten evidence waits for in-process tests without changing production windows.
      NEURAFLOK_EVIDENCE_MS: '1500'
    }
  }
});
