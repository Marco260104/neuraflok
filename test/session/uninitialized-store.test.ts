import {
  createSession,
  dir,
  initSessionStore,
  listSessions,
  unsetSessionRootForTests,
} from './context.js';
import { afterEach, describe, expect, it } from 'vitest';

/** Where the store writes when nobody has told it where. `root` starts as the empty string, and `path.join('', id)` is a relative path — so an uninitialised store did not fail, it wrote real session folders into the process's working directory. Recording being off by default hid that completely. The moment it was turned on, a test run started leaving recordings scattered through the repository, and the only reason it was noticed was `git status`. */
describe('a session store nobody has pointed anywhere', () => {
  afterEach(() => {
    initSessionStore(dir);
  });

  it('refuses to write rather than falling back to the working directory', async () => {
    unsetSessionRootForTests();
    await expect(createSession({ conversationId: null })).rejects.toThrow(/initSessionStore/);
  });

  it('refuses to read as well, instead of reporting an empty history', async () => {
    unsetSessionRootForTests();
    await expect(listSessions()).rejects.toThrow(/initSessionStore/);
  });
});
