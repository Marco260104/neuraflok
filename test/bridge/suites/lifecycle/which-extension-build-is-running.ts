import { afterEach, describe, expect, getLog, it, pair, request, setShippedExtensionBuildForTest, vi } from "../../test-context.js";

describe("which extension build is running", () => {
  const SHIPPED = 'a0a0a0a0a0a0';

  afterEach(() => setShippedExtensionBuildForTest());

  it('announces each build once while two browsers alternate, and says when one is not the shipped build', async () => {
      // Measured 2026-09-26: a normal and a debugging Chrome on different builds alternated requests, and every alternation logged "connected" and pushed renderer state.
      setShippedExtensionBuildForTest(SHIPPED);
      const said = (build: string) => getLog().filter((entry) => entry.message.includes(`connected (build ${build})`)).length;
      const warned = (build: string) => getLog().filter((entry) => entry.message.includes(`companion build ${build} differs from shipped build ${SHIPPED}`)).length;
      const before = { a: said('b1b1b1b1b1b1'), w: warned('b1b1b1b1b1b1') };
      for (let i = 0; i < 5; i++) {
        await request('GET', '/hello', { auth: null, extensionBuild: SHIPPED });
        await request('GET', '/hello', { auth: null, extensionBuild: 'b1b1b1b1b1b1' });
      }
      expect(said('b1b1b1b1b1b1') - before.a).toBe(1);
      expect(warned('b1b1b1b1b1b1') - before.w, 'the different companion build is named once').toBe(1);
      expect(warned(SHIPPED), 'the shipped build is never called different').toBe(0);
      // Expected after every app update and followed by the self-update: information, not a problem.
      expect(getLog().filter(entry => entry.message.includes('companion build b1b1b1b1b1b1 differs')).map(entry => entry.level)).toEqual(['info']);
    });

  it('refuses work to an out-of-date companion only while an up-to-date one is present', async () => {
      // 2026-09-26: a second Chrome on the pre-update extension claimed a planner input the current browser was waiting for, and could not finish it on the newer ChatGPT shell.
      setShippedExtensionBuildForTest(SHIPPED);
      await pair();
      const stale = { body: { id: 'x', client: 'stale-client' }, extensionBuild: 'deadbeefcafe' };
      const alone = await request('POST', '/commands/redeem', stale);
      expect(alone.body.error, 'a lone older browser keeps working').not.toBe('stale_extension_build');
      await request('GET', '/status', { extensionBuild: SHIPPED });
      const refused = await request('POST', '/commands/redeem', stale);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('stale_extension_build');
      expect((await request('POST', '/repairs/claim', { body: {}, extensionBuild: 'deadbeefcafe' })).body).toEqual({ allowed: false });
      const current = await request('POST', '/commands/redeem', { body: { id: 'x', client: 'current-client' }, extensionBuild: SHIPPED });
      expect(current.body.error).not.toBe('stale_extension_build');
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
      try {
        const later = await request('POST', '/commands/redeem', stale);
        expect(later.body.error, 'the up-to-date browser went quiet a minute ago').not.toBe('stale_extension_build');
      } finally { clock.mockRestore(); }
    });

  it('compares nothing in a checkout that was never packaged', async () => {
      setShippedExtensionBuildForTest(null);
      const warnings = () => getLog().filter((entry) => entry.message.includes('but this app ships')).length;
      const before = warnings();
      await pair();
      await request('GET', '/status', { extensionBuild: 'a1a1a1a1a1a1' });
      const other = await request('POST', '/commands/redeem', { body: { id: 'x', client: 'c' }, extensionBuild: 'deadbeefcafe' });
      expect(other.body.error).not.toBe('stale_extension_build');
      expect(warnings()).toBe(before);
    });
});
