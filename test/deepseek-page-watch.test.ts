import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error Browser extension modules are plain JavaScript.
import { createDeepseekReplyWatcher } from '../browser-extension/src/background/providers/execution/deepseek-watch.js';
// @ts-expect-error Browser extension modules are plain JavaScript.
import { createDeepseekPageExecutor } from '../browser-extension/src/background/providers/execution/deepseek.js';
// @ts-expect-error Browser extension modules are plain JavaScript.
import { createProviderPageState } from '../browser-extension/src/background/providers/delivery-ledger.js';

function memoryStorage(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => key in data).map(key => [key, data[key]]));
    },
    async set(values: Record<string, unknown>) {
      Object.assign(data, structuredClone(values));
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

function freshRouteTabReply(tabReply: (...args: any[]) => Promise<any>, tab: { url: string; status?: string }) {
  let opened = false;
  let sendAttempted = false;
  return vi.fn(async (...args: any[]) => {
    const [, message] = args as [number, { type: string }];
    if (message.type === 'neuraflok-deepseek-open-new-chat') {
      const reply = await tabReply(...args);
      if (reply && typeof reply === 'object' && typeof reply.error === 'string') return reply;
      opened = true;
      tab.url = 'https://chat.deepseek.com/a/chat/s/new-conversation';
      tab.status = 'complete';
      return reply?.started === true ? reply : { started: true };
    }
    if (message.type === 'neuraflok-deepseek-complete') {
      try {
        const reply = await tabReply(...args);
        if (reply?.openedNewChat !== true) sendAttempted = true;
        return reply;
      } catch (error) {
        sendAttempted = true;
        throw error;
      }
    }
    const reply = await tabReply(...args);
    if (opened && !sendAttempted && message.type === 'neuraflok-deepseek-snapshot' && reply && typeof reply === 'object') {
      return {
        ...reply,
        newChatRoute: true,
        freshConversation: true,
        hasConversation: false,
        before: '',
        answer: ''
      };
    }
    return reply;
  });
}

const fastFreshRoute = { pollMs: 1, signedSettleMs: 0, freshRouteStableMs: 0, freshRouteTimeoutMs: 40 };

afterEach(() => {
  vi.useRealTimers();
});

function watchHarness(pages: Array<Record<string, unknown>>, timings: Record<string, number> = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const postTimes: number[] = [];
  const resumes: string[] = [];
  const progress: Array<Record<string, unknown>> = [];
  let index = 0;
  const tabReply = vi.fn(async (_tabId: number, message: { type: string }) => {
    if (message.type === 'neuraflok-deepseek-resume') {
      resumes.push('resume');
      return { ok: true, mode: 'click' };
    }
    const page = pages[Math.min(index, pages.length - 1)]!;
    if (message.type === 'neuraflok-deepseek-read' || message.type === 'neuraflok-deepseek-snapshot') {
      index += 1;
      return page;
    }
    return page;
  });
  const call = vi.fn(async (route: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (route === '/provider/page/progress') progress.push(body);
    return { ok: true, data: { ok: true } };
  });
  const { watchDeepseekReply } = createDeepseekReplyWatcher({
    tabReply,
    call,
    timings,
    postDeepseekPage: async (_offer: { id: string }, body: Record<string, unknown>) => {
      posted.push(body);
      postTimes.push(Date.now());
      return true;
    },
    stoppedProviderOffers: new Set()
  });
  return { watchDeepseekReply, posted, postTimes, resumes, progress, tabReply };
}

const offer = { id: 'offer-1', conversationId: 'ds-00000000-0000-4000-8000-000000000001' };

it('does not post DeepSeek reasoning as the public reply', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted, progress } = watchHarness([
    { generating: true, canContinue: false, answer: '', think: 'Let me inspect src/App.tsx and the router next.', text: 'Let me inspect src/App.tsx and the router next.' },
    { generating: true, canContinue: false, answer: '', think: 'Let me inspect src/App.tsx and the router next.', text: 'Let me inspect src/App.tsx and the router next.' },
    { generating: false, canContinue: false, answer: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/src/App.tsx"]}}\n```', think: 'Let me inspect src/App.tsx and the router next.', text: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/src/App.tsx"]}}\n```' }
  ]);
  const running = watchDeepseekReply(7, offer, 'NEURAFLOK_READY', '', '');
  await vi.advanceTimersByTimeAsync(20_000);
  await running;
  expect(posted.some(row => typeof row.text === 'string' && row.text.includes('Let me inspect'))).toBe(false);
  expect(progress.some(row => typeof row.text === 'string' && row.text.includes('Let me inspect'))).toBe(false);
  expect(posted.at(-1)).toMatchObject({
    text: expect.stringContaining('```neuraflok-tool')
  });
});

it('posts a finished Spanish reply even if leftover think remains on the page', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted, progress } = watchHarness([
    {
      generating: false, canContinue: false,
      answer: 'Voy a leer AGENTS.md y continuar el arbol binario desde insert.',
      think: 'Let me inspect the previous patch and decide the next file.',
      text: 'Voy a leer AGENTS.md y continuar el arbol binario desde insert.'
    }
  ]);
  const running = watchDeepseekReply(7, offer, '', '', '');
  await vi.advanceTimersByTimeAsync(20_000);
  await running;
  expect(posted.at(-1)).toMatchObject({
    text: expect.stringContaining('Voy a leer AGENTS.md')
  });
  expect(progress.some(row => row.generating === true)).toBe(false);
});

it('settles a finished Spanish reply even if DeepSeek keeps reporting generating', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted } = watchHarness([
    {
      generating: true, canContinue: false,
      answer: 'Voy a leer AGENTS.md y continuar el arbol binario desde insert.',
      think: 'Let me inspect the previous patch and decide the next file.',
      text: 'Voy a leer AGENTS.md y continuar el arbol binario desde insert.'
    }
  ]);
  const running = watchDeepseekReply(7, offer, '', '', '');
  for (let i = 0; i < 24 && posted.length === 0; i += 1) {
    await vi.advanceTimersByTimeAsync(2_000);
  }
  await running;
  expect(posted.at(-1)).toMatchObject({
    text: expect.stringContaining('Voy a leer AGENTS.md')
  });
});

it('settles a finished reply instead of clicking a stale Continue control', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted, resumes } = watchHarness([
    {
      generating: false, canContinue: true,
      answer: 'El arbol binario ya tiene insert, search y los tests pedidos.',
      think: '',
      text: 'El arbol binario ya tiene insert, search y los tests pedidos.'
    }
  ]);
  const running = watchDeepseekReply(7, offer, '', '', '');
  await vi.advanceTimersByTimeAsync(20_000);
  await running;
  expect(resumes).toEqual([]);
  expect(posted.at(-1)).toMatchObject({
    text: expect.stringContaining('El arbol binario ya tiene insert')
  });
});

it('clicks Continue generating when DeepSeek pauses a long reply', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted, resumes } = watchHarness([
    { generating: false, canContinue: true, answer: '```neuraflok-tool\n{"name":"apply_patch","arguments":{"patch":', think: '', text: '' },
    { generating: true, canContinue: false, answer: '```neuraflok-tool\n{"name":"apply_patch","arguments":{"patch":', think: '', text: '' },
    { generating: false, canContinue: false, answer: '```neuraflok-tool\n{"name":"apply_patch","arguments":{"patch":"*** Begin Patch\\n*** Add File: /workspace/src/App.tsx\\n+export default function App(){return null}\\n*** End Patch"}}\n```', think: '', text: '' }
  ]);
  const running = watchDeepseekReply(7, offer, '', '', '');
  await vi.advanceTimersByTimeAsync(20_000);
  await running;
  expect(resumes.length).toBeGreaterThan(0);
  expect(posted.at(-1)).toMatchObject({
    text: expect.stringContaining('App.tsx')
  });
});

it('does not restart the no-progress deadline for repeated Continue clicks', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted, postTimes, resumes } = watchHarness([
    { generating: true, canContinue: true, answer: '', think: 'Detenido', text: '' }
  ], { readMs: 5, watchMs: 40, pollMs: 5, maxResumes: 100 });
  const startedAt = Date.now();
  const running = watchDeepseekReply(7, offer, 'Yesterday’s answer is still visible.', '', '');

  await vi.advanceTimersByTimeAsync(100);
  await running;

  expect(resumes.length).toBeGreaterThan(0);
  expect(postTimes.at(-1)! - startedAt).toBeLessThan(100);
  expect(posted.at(-1)).toMatchObject({ error: expect.stringMatching(/did not finish/i) });
});

it('keeps a long reply alive while new public text continues to arrive', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted } = watchHarness([
    { generating: true, canContinue: false, answer: 'Progress 1', think: '', text: 'Progress 1' },
    { generating: true, canContinue: false, answer: 'Progress 2', think: '', text: 'Progress 2' },
    { generating: true, canContinue: false, answer: 'Progress 3', think: '', text: 'Progress 3' },
    { generating: true, canContinue: false, answer: 'Progress 4', think: '', text: 'Progress 4' },
    { generating: false, canContinue: false, answer: 'The requested long task is complete after the project was inspected and the changes were verified.', think: '', text: '' }
  ], { readMs: 5, watchMs: 30, pollMs: 5 });
  const running = watchDeepseekReply(7, offer, '', '', '');

  await vi.advanceTimersByTimeAsync(100);
  await running;

  expect(posted.at(-1)).toMatchObject({
    text: expect.stringContaining('long task is complete')
  });
});

it('sends a continue prompt when a tool fence is cut off and no Continue button is present', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted, resumes } = watchHarness([
    { generating: false, canContinue: false, answer: '```neuraflok-tool\n{"name":"read","arguments":{"paths":', think: '', text: '' },
    { generating: true, canContinue: false, answer: '```neuraflok-tool\n{"name":"read","arguments":{"paths":', think: '', text: '' },
    { generating: false, canContinue: false, answer: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/src/theme.ts"]}}\n```', think: '', text: '' }
  ]);
  const running = watchDeepseekReply(7, offer, '', '', '');
  await vi.advanceTimersByTimeAsync(20_000);
  await running;
  expect(resumes.length).toBeGreaterThan(0);
  expect(posted.at(-1)).toMatchObject({
    text: expect.stringContaining('theme.ts')
  });
});

it('clicks Continue even when the leftover previous answer is still lastAnswer', async () => {
  vi.useFakeTimers();
  const leftover = 'El descuento dinámico ya está en core.js y BookshopApp.js.';
  const { watchDeepseekReply, posted, resumes } = watchHarness([
    { generating: true, canContinue: true, answer: leftover, think: 'Detenido', text: leftover },
    { generating: true, canContinue: false, answer: leftover, think: '', text: leftover },
    { generating: false, canContinue: false, answer: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/src/App.tsx"]}}\n```', think: '', text: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/src/App.tsx"]}}\n```' }
  ]);
  const running = watchDeepseekReply(7, offer, leftover, '', leftover);
  await vi.advanceTimersByTimeAsync(20_000);
  await running;
  expect(resumes.length).toBeGreaterThan(0);
  expect(posted.at(-1)).toMatchObject({
    text: expect.stringContaining('App.tsx')
  });
});

it('clicks Continue while leftover generating chrome is still on a Detenido stall', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted, resumes } = watchHarness([
    { generating: true, canContinue: true, answer: '', think: 'Detenido Voy a listar los archivos.', text: '' },
    { generating: true, canContinue: false, answer: '', think: '', text: '' },
    { generating: false, canContinue: false, answer: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/src/App.tsx"]}}\n```', think: '', text: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/src/App.tsx"]}}\n```' }
  ]);
  const running = watchDeepseekReply(7, offer, '', '', '');
  await vi.advanceTimersByTimeAsync(20_000);
  await running;
  expect(resumes.length).toBeGreaterThan(0);
  expect(posted.at(-1)).toMatchObject({
    text: expect.stringContaining('App.tsx')
  });
});

it('resumes a server-unavailable stall even if the page still reports generating', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted, resumes } = watchHarness([
    { generating: true, canContinue: true, answer: 'El servidor no está disponible temporalmente', think: 'Detenido', text: 'El servidor no está disponible temporalmente' },
    { generating: true, canContinue: false, answer: '', think: '', text: '' },
    { generating: false, canContinue: false, answer: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/src/App.tsx"]}}\n```', think: '', text: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/src/App.tsx"]}}\n```' }
  ]);
  const running = watchDeepseekReply(7, offer, '', '', '');
  await vi.advanceTimersByTimeAsync(20_000);
  await running;
  expect(resumes.length).toBeGreaterThan(0);
  expect(posted.some(row => typeof row.text === 'string' && /servidor no/i.test(row.text))).toBe(false);
  expect(posted.at(-1)).toMatchObject({
    text: expect.stringContaining('App.tsx')
  });
});

it('resumes when DeepSeek shows a temporary server-unavailable banner', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted, resumes } = watchHarness([
    { generating: false, canContinue: false, answer: 'El servidor no está disponible temporalmente', think: '', text: 'El servidor no está disponible temporalmente' },
    { generating: true, canContinue: false, answer: '', think: '', text: '' },
    { generating: false, canContinue: false, answer: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/src/App.tsx"]}}\n```', think: '', text: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/src/App.tsx"]}}\n```' }
  ]);
  const running = watchDeepseekReply(7, offer, '', '', '');
  await vi.advanceTimersByTimeAsync(20_000);
  await running;
  expect(resumes.length).toBeGreaterThan(0);
  expect(posted.some(row => typeof row.text === 'string' && /servidor no/i.test(row.text))).toBe(false);
  expect(posted.at(-1)).toMatchObject({
    text: expect.stringContaining('App.tsx')
  });
});

it('keeps watching after a provider_page_timeout on a read poll', async () => {
  vi.useFakeTimers();
  const posted: Array<Record<string, unknown>> = [];
  let reads = 0;
  const tabReply = vi.fn(async (_tabId: number, message: { type: string }) => {
    if (message.type === 'neuraflok-deepseek-read') {
      reads += 1;
      if (reads === 1) throw new Error('provider_page_timeout');
      return {
        generating: false, canContinue: false,
        answer: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/a.ts"]}}\n```',
        think: '',
        text: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/a.ts"]}}\n```'
      };
    }
    return null;
  });
  const { watchDeepseekReply } = createDeepseekReplyWatcher({
    tabReply,
    call: vi.fn(async () => ({ ok: true, data: { ok: true } })),
    postDeepseekPage: async (_offer: { id: string }, body: Record<string, unknown>) => {
      posted.push(body);
      return true;
    },
    stoppedProviderOffers: new Set()
  });
  const running = watchDeepseekReply(7, offer, '', '', '');
  await vi.advanceTimersByTimeAsync(20_000);
  await running;
  expect(posted.some(row => typeof row.error === 'string')).toBe(false);
  expect(posted.at(-1)).toMatchObject({
    text: expect.stringContaining('/workspace/a.ts')
  });
});

it('does not post a leftover snapshot as the reply when the public answer is still empty', async () => {
  vi.useFakeTimers();
  const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)';
  const posted: Array<Record<string, unknown>> = [];
  const tabReply = vi.fn(async (_tabId: number, message: { type: string }) => {
    if (message.type === 'neuraflok-deepseek-snapshot') {
      return { generating: false, canContinue: false, before: leftover, beforeThink: '' };
    }
    if (message.type === 'neuraflok-deepseek-read') {
      return { generating: false, canContinue: false, answer: '', think: '', text: '' };
    }
    return null;
  });
  const { watchDeepseekReply } = createDeepseekReplyWatcher({
    tabReply,
    call: vi.fn(async () => ({ ok: true, data: { ok: true } })),
    postDeepseekPage: async (_offer: { id: string }, body: Record<string, unknown>) => {
      posted.push(body);
      return true;
    },
    stoppedProviderOffers: new Set()
  });
  const running = watchDeepseekReply(7, offer, '', '', '');
  await vi.advanceTimersByTimeAsync(400_000);
  await running;
  expect(posted.some(row => typeof row.text === 'string' && row.text.includes('descuento dinámico'))).toBe(false);
  expect(posted.at(-1)).toMatchObject({
    error: expect.stringMatching(/never started|did not finish/i)
  });
});

it('posts a new project recap that differs from leftover paint on a fresh project watch', async () => {
  vi.useFakeTimers();
  const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
  const next = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nTambién apliqué el parche de SPEC.md. npm run dev.';
  const { watchDeepseekReply, posted } = watchHarness([
    { generating: true, canContinue: false, answer: leftover, think: '', text: leftover },
    { generating: false, canContinue: false, answer: next, think: '', text: next }
  ]);
  const running = watchDeepseekReply(7, {
    ...offer,
    fresh: true,
    text: `Project tree\ncore.js\n\nWhere we left off: ${leftover}\n\n## Current user request\nSigue con SPEC.md`
  }, leftover, '', '');
  await vi.advanceTimersByTimeAsync(10_000);
  await running;
  expect(posted.some(row => typeof row.text === 'string' && row.text === leftover)).toBe(false);
  expect(posted.at(-1)).toMatchObject({ text: next });
});

it('does not post leftover recap as the bootstrap reply on a fresh project tab', async () => {
  vi.useFakeTimers();
  const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
  const { watchDeepseekReply, posted } = watchHarness([
    { generating: false, canContinue: false, answer: leftover, think: '', text: leftover },
    { generating: false, canContinue: false, answer: leftover, think: '', text: leftover },
    { generating: false, canContinue: false, answer: 'NEURAFLOK_READY', think: '', text: 'NEURAFLOK_READY' }
  ]);
  const running = watchDeepseekReply(7, {
    ...offer,
    fresh: true,
    text: 'Initialize this NEURAFLOK conversation using the instructions below. Reply with exactly NEURAFLOK_READY.'
  }, '', '', '');
  await vi.advanceTimersByTimeAsync(20_000);
  await running;
  expect(posted.some(row => typeof row.text === 'string' && row.text.includes('descuento dinámico'))).toBe(false);
  expect(posted.at(-1)).toMatchObject({ text: 'NEURAFLOK_READY' });
});

it('posts a conversation-only greeting on the 5 second poll', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted } = watchHarness([
    { generating: true, canContinue: false, answer: '', think: 'We need answer Spanish.', text: '' },
    { generating: false, canContinue: false, answer: 'Hola. ¿En qué te ayudo?', think: '', text: 'Hola. ¿En qué te ayudo?' }
  ]);
  const running = watchDeepseekReply(7, {
    ...offer,
    fresh: true,
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola'
  }, '', '', '');
  await vi.advanceTimersByTimeAsync(4_000);
  expect(posted).toEqual([]);
  await vi.advanceTimersByTimeAsync(6_000);
  await running;
  expect(posted.some(row => typeof row.text === 'string' && row.text.includes('We need'))).toBe(false);
  expect(posted.at(-1)).toMatchObject({ text: 'Hola. ¿En qué te ayudo?' });
});

it('posts a new greeting after leftover recap on a conversation-only watch', async () => {
  vi.useFakeTimers();
  const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
  const { watchDeepseekReply, posted, resumes } = watchHarness([
    { generating: true, canContinue: true, answer: leftover, think: 'Detenido', text: leftover },
    { generating: true, canContinue: false, answer: leftover, think: '', text: leftover },
    { generating: false, canContinue: false, answer: 'Hola. ¿En qué te ayudo?', think: '', text: 'Hola. ¿En qué te ayudo?' }
  ]);
  const running = watchDeepseekReply(7, {
    ...offer,
    fresh: true,
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola'
  }, leftover, '', leftover);
  await vi.advanceTimersByTimeAsync(10_000);
  await running;
  expect(resumes).toEqual([]);
  expect(posted.some(row => typeof row.text === 'string' && row.text.includes('descuento dinámico'))).toBe(false);
  expect(posted.at(-1)).toMatchObject({
    text: 'Hola. ¿En qué te ayudo?'
  });
});

it('does not treat leftover recap as the reply during the first seconds of a conversation-only watch', async () => {
  vi.useFakeTimers();
  const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
  const { watchDeepseekReply, posted } = watchHarness([
    { generating: true, canContinue: true, answer: leftover, think: 'Detenido', text: leftover }
  ]);
  const running = watchDeepseekReply(7, {
    ...offer,
    fresh: true,
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola'
  }, leftover, '', leftover);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(posted).toEqual([]);
  await vi.advanceTimersByTimeAsync(100_000);
  await running;
  expect(posted.some(row => typeof row.text === 'string' && row.text.includes('descuento dinámico'))).toBe(false);
  expect(posted.at(-1)).toMatchObject({
    error: expect.stringMatching(/previous conversation/i)
  });
});

it('settles the watch deadline instead of throwing from the deadline helper', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted } = watchHarness([
    { generating: true, canContinue: false, answer: 'Still streaming this long reply.', think: '', text: 'Still streaming this long reply.' }
  ], { watchMs: 1_000, pollMs: 10, readMs: 50 });
  const running = watchDeepseekReply(7, offer, '', '', '');
  await vi.advanceTimersByTimeAsync(3_000);
  await expect(running).resolves.toBeUndefined();
  expect(posted.at(-1)).toMatchObject({ text: 'Still streaming this long reply.' });
});

it('fails fast when the page stays idle and never starts the reply', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted } = watchHarness([
    { generating: false, canContinue: false, answer: '', think: '', text: '' }
  ], { watchMs: 400_000, pollMs: 10, readMs: 50, idleNoReplyMs: 100 });
  const running = watchDeepseekReply(7, offer, 'Previous answer', '', '');
  await vi.advanceTimersByTimeAsync(5_000);
  await running;
  expect(posted.at(-1)).toMatchObject({
    error: expect.stringMatching(/never started/i)
  });
});

it('prefers an already-grown public answer over a timeout error', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted } = watchHarness([
    { generating: false, canContinue: false, answer: 'The dashboard layout uses a 12-column grid and CSS modules.', think: '', text: 'The dashboard layout uses a 12-column grid and CSS modules.' }
  ]);
  const running = watchDeepseekReply(7, offer, '', '', '');
  await vi.advanceTimersByTimeAsync(20_000);
  await running;
  expect(posted.at(-1)).toEqual({
    text: 'The dashboard layout uses a 12-column grid and CSS modules.'
  });
  expect(posted.some(row => typeof row.error === 'string')).toBe(false);
});

it('sends only after a stable DeepSeek new-chat route is confirmed', async () => {
  const tab = { id: 31, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const opened: string[] = [];
  const tabReply = vi.fn(async (_id: number, message: { type: string }) => {
    if (message.type === 'neuraflok-deepseek-status' || message.type === 'neuraflok-deepseek-snapshot') {
      return {
        signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '',
        freshConversation: true, hasConversation: false, newChatRoute: true, newChatAvailable: true
      };
    }
    if (message.type === 'neuraflok-deepseek-complete') return { text: 'Hola. ¿En qué te ayudo?' };
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async () => tab) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply: freshRouteTabReply(tabReply, tab),
    createBrowserTab: async (url: string) => {
      opened.push(url);
      return tab;
    },
    queryProviderTabs: async () => [],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: { freshSettleMs: 0, freshRouteStableMs: 0 }
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000095',
    provider: 'deepseek',
    conversationId: 'ds-44444444-4444-4444-8444-444444444444',
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola',
    fresh: true
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('Hola. ¿En qué te ayudo?')
  })));
  expect(opened[0]).toBe('https://chat.deepseek.com/');
});

it('retries New chat when DeepSeek restores the previous thread, then sends once the route is stable', async () => {
  const previous = 'Respuesta anterior restaurada desde la sesión web.';
  const tab = { id: 341, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const completions: Array<Record<string, unknown>> = [];
  let openCalls = 0;
  let routeFresh = false;
  const tabReply = vi.fn(async (_id: number, message: {
    type: string; fresh?: boolean; before?: string; openedNewChat?: boolean; beforeIdentity?: string;
    freshRouteStableMs?: number; freshRouteWaitMs?: number; freshRouteRestored?: boolean;
  }) => {
    if (message.type === 'neuraflok-deepseek-status') {
      return { signedIn: true, generating: false, conversationId: null };
    }
    if (message.type === 'neuraflok-deepseek-snapshot') {
      if (routeFresh) {
        return {
          signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '', answer: '',
          freshConversation: true, hasConversation: false, newChatRoute: true, newChatAvailable: true
        };
      }
      return {
        signedIn: true, generating: false, conversationId: null,
        before: previous, beforeThink: '', answer: previous, beforeIdentity: 'message:old',
        freshConversation: false, hasConversation: true, newChatRoute: false, newChatAvailable: true
      };
    }
    if (message.type === 'neuraflok-deepseek-open-new-chat') {
      openCalls += 1;
      routeFresh = openCalls >= 2;
      tab.url = 'https://chat.deepseek.com/a/chat/s/new-conversation';
      return { started: true };
    }
    if (message.type === 'neuraflok-deepseek-complete') {
      completions.push({
        fresh: message.fresh, openedNewChat: message.openedNewChat,
        before: message.before, beforeIdentity: message.beforeIdentity,
        freshRouteStableMs: message.freshRouteStableMs, freshRouteWaitMs: message.freshRouteWaitMs
      });
      return { text: 'Hola. ¿En qué te ayudo?' };
    }
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async () => tab) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply,
    createBrowserTab: async () => tab,
    queryProviderTabs: async () => [],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    state: createProviderPageState(chrome),
    snapshotTimings: { pollMs: 1, signedSettleMs: 0, freshRouteStableMs: 0, freshRouteTimeoutMs: 10 }
  });

  executor.inspect({
    id: '00000000-0000-4000-8000-000000000096',
    provider: 'deepseek',
    conversationId: 'ds-66666666-6666-4666-8666-666666666666',
    text: 'Prueba breve de inicio',
    fresh: true
  }, false);

  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('Hola. ¿En qué te ayudo?')
  })), { timeout: 3_000 });
  expect(openCalls).toBe(2);
  expect(completions).toHaveLength(1);
  expect(completions[0]).toMatchObject({
    fresh: true, openedNewChat: true, before: previous, beforeIdentity: 'message:old',
    freshRouteStableMs: 0, freshRouteWaitMs: expect.any(Number)
  });
});

it('reopens New chat after a delayed restoration and retries with a short stable route', async () => {
  const previous = 'Respuesta anterior restaurada desde la sesión web.';
  const tab = { id: 342, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const completions: Array<Record<string, unknown>> = [];
  let openCalls = 0;
  let snapshotsAfterOpen = 0;
  let routeFresh = false;
  const tabReply = vi.fn(async (_id: number, message: {
    type: string; fresh?: boolean; before?: string; openedNewChat?: boolean; beforeIdentity?: string;
    freshRouteStableMs?: number; freshRouteWaitMs?: number; freshRouteRestored?: boolean;
  }) => {
    if (message.type === 'neuraflok-deepseek-status') {
      return { signedIn: true, generating: false, conversationId: null };
    }
    if (message.type === 'neuraflok-deepseek-snapshot') {
      if (openCalls === 0) {
        return {
          signedIn: true, generating: false, conversationId: null,
          before: previous, beforeThink: '', answer: previous, beforeIdentity: 'message:old',
          freshConversation: false, hasConversation: true, newChatRoute: false, newChatAvailable: true
        };
      }
      if (routeFresh) {
        return {
          signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '', answer: '',
          freshConversation: true, hasConversation: false, newChatRoute: true, newChatAvailable: true
        };
      }
      snapshotsAfterOpen += 1;
      if (snapshotsAfterOpen === 1) {
        return {
          signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '', answer: '',
          freshConversation: true, hasConversation: false, newChatRoute: true, newChatAvailable: true
        };
      }
      return {
        signedIn: true, generating: false, conversationId: null,
        before: previous, beforeThink: '', answer: previous, beforeIdentity: 'message:old',
        freshConversation: false, hasConversation: true, newChatRoute: false, newChatAvailable: true
      };
    }
    if (message.type === 'neuraflok-deepseek-open-new-chat') {
      openCalls += 1;
      snapshotsAfterOpen = 0;
      routeFresh = openCalls >= 2;
      tab.url = 'https://chat.deepseek.com/a/chat/s/new-conversation';
      return { started: true };
    }
    if (message.type === 'neuraflok-deepseek-complete') {
      completions.push({
        fresh: message.fresh, openedNewChat: message.openedNewChat,
        before: message.before, beforeIdentity: message.beforeIdentity,
        freshRouteStableMs: message.freshRouteStableMs, freshRouteWaitMs: message.freshRouteWaitMs,
        freshRouteRestored: message.freshRouteRestored
      });
      return { text: 'Hola. ¿En qué te ayudo?' };
    }
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async () => tab) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply,
    createBrowserTab: async () => tab,
    queryProviderTabs: async () => [],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    state: createProviderPageState(chrome),
    snapshotTimings: { pollMs: 1, signedSettleMs: 0, freshRouteStableMs: 10, freshRouteTimeoutMs: 60, freshRouteRestoredMs: 5 }
  });

  executor.inspect({
    id: '00000000-0000-4000-8000-000000000097',
    provider: 'deepseek',
    conversationId: 'ds-77777777-7777-4777-8777-777777777777',
    text: 'Prueba breve de inicio',
    fresh: true
  }, false);

  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('Hola. ¿En qué te ayudo?')
  })), { timeout: 3_000 });
  expect(openCalls).toBe(2);
  expect(completions).toHaveLength(1);
  expect(completions[0]).toMatchObject({
    fresh: true, openedNewChat: true, before: previous, beforeIdentity: 'message:old',
    freshRouteStableMs: 5, freshRouteWaitMs: expect.any(Number), freshRouteRestored: true
  });
});

it('surfaces a rejected fresh-chat send immediately instead of watching an unsent turn', async () => {
  const tab = { id: 35, url: 'https://chat.deepseek.com/', status: 'complete' };
  const pageResults: Array<Record<string, unknown>> = [];
  let routeOpened = false;
  const call = vi.fn(async (route: string, init?: { body?: string }) => {
    if (route === '/provider/page' && init?.body) pageResults.push(JSON.parse(init.body) as Record<string, unknown>);
    return { ok: true, data: { ok: true } };
  });
  const tabReply = vi.fn(async (_id: number, message: { type: string }) => {
    if (message.type === 'neuraflok-deepseek-status') {
      return { signedIn: true, generating: false, conversationId: null };
    }
    if (message.type === 'neuraflok-deepseek-snapshot') {
      if (routeOpened) {
        return {
          signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '', answer: '',
          freshConversation: true, hasConversation: false, newChatRoute: true, newChatAvailable: true
        };
      }
      return {
        signedIn: true, generating: false, conversationId: null,
        before: '', beforeThink: '', freshConversation: true,
        hasConversation: false, newChatRoute: false, newChatAvailable: true
      };
    }
    if (message.type === 'neuraflok-deepseek-complete') {
      return { error: 'DeepSeek did not confirm a new conversation. No message was sent.' };
    }
    if (message.type === 'neuraflok-deepseek-open-new-chat') {
      routeOpened = true;
      tab.url = 'https://chat.deepseek.com/a/chat/s/new-conversation';
      return { started: true };
    }
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async () => tab) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply,
    createBrowserTab: async () => tab,
    queryProviderTabs: async () => [],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: { pollMs: 1, signedSettleMs: 0, freshRouteStableMs: 2, freshRouteTimeoutMs: 100 }
  });

  executor.inspect({
    id: '00000000-0000-4000-8000-000000000099',
    provider: 'deepseek',
    conversationId: 'ds-77777777-7777-4777-8777-777777777777',
    text: 'Prueba de envío no confirmado',
    fresh: true
  }, false);

  await vi.waitFor(() => expect(pageResults).toHaveLength(1));
  expect(pageResults[0]).toMatchObject({
    error: expect.stringContaining('No message was sent')
  });
  expect(tabReply.mock.calls.filter(([_, message]) => message.type === 'neuraflok-deepseek-complete')).toHaveLength(1);
});

it('reinjects the content script when a fresh tab has no snapshot yet', async () => {
  const tab = { id: 33, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  let restores = 0;
  let snaps = 0;
  const tabReply = vi.fn(async (_id: number, message: { type: string }) => {
    if (message.type === 'neuraflok-deepseek-status') {
      return restores > 0 ? { signedIn: true, generating: false, conversationId: null } : null;
    }
    if (message.type === 'neuraflok-deepseek-snapshot') {
      snaps += 1;
      if (restores < 2) return null;
      return { signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '' };
    }
    if (message.type === 'neuraflok-deepseek-complete') return { text: 'Hola. ¿En qué te ayudo?' };
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async () => tab) }
  };
  const restoreDeepseekTab = vi.fn(async () => {
    restores += 1;
    return true;
  });
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply: freshRouteTabReply(tabReply, tab),
    createBrowserTab: async () => tab,
    queryProviderTabs: async () => [],
    restoreDeepseekTab,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: fastFreshRoute
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000104',
    provider: 'deepseek',
    conversationId: 'ds-55555555-5555-4555-8555-555555555557',
    text: 'This is a conversation only.\n\nHola',
    fresh: true
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('Hola. ¿En qué te ayudo?')
  })));
  expect(restores).toBeGreaterThan(0);
  expect(snaps).toBeGreaterThan(0);
  expect(JSON.stringify(call.mock.calls)).not.toMatch(/Sign in to DeepSeek/);
});

it('waits for DeepSeek sign-in on a fresh tab instead of failing on the first snapshot', async () => {
  const tab = { id: 32, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  let snaps = 0;
  const tabReply = vi.fn(async (_id: number, message: { type: string }) => {
    if (message.type === 'neuraflok-deepseek-status') {
      return { signedIn: snaps > 0, generating: false, conversationId: null };
    }
    if (message.type === 'neuraflok-deepseek-snapshot') {
      snaps += 1;
      return {
        signedIn: snaps > 1,
        generating: false,
        conversationId: null,
        before: '',
        beforeThink: ''
      };
    }
    if (message.type === 'neuraflok-deepseek-complete') return { text: 'Hola. ¿En qué te ayudo?' };
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async () => tab) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply: freshRouteTabReply(tabReply, tab),
    createBrowserTab: async () => tab,
    queryProviderTabs: async () => [],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: fastFreshRoute
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000094',
    provider: 'deepseek',
    conversationId: 'ds-55555555-5555-4555-8555-555555555555',
    text: 'This is a conversation only.\n\nHola',
    fresh: true
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('Hola. ¿En qué te ayudo?')
  })));
  expect(snaps).toBeGreaterThan(1);
  expect(JSON.stringify(call.mock.calls)).not.toMatch(/Sign in to DeepSeek/);
});

it('opens a new DeepSeek tab when the bound tab is gone instead of claiming an unclaimed home tab', async () => {
  const unclaimed = { id: 21, url: 'https://chat.deepseek.com/', title: 'DeepSeek', status: 'complete' };
  const opened = { id: 77, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const tabReply = vi.fn(async (id: number, message: { type: string; fresh?: boolean }) => {
    if (id === 21) throw new Error('must not reuse an unclaimed DeepSeek tab');
    if (message.type === 'neuraflok-deepseek-status' || message.type === 'neuraflok-deepseek-snapshot') {
      return { signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '' };
    }
    if (message.type === 'neuraflok-deepseek-complete') {
      expect(message.fresh).toBe(true);
      return { text: 'follow-up on a new tab' };
    }
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async (id: number) => {
      if (id === 77) return opened;
      throw new Error('tab gone');
    }) }
  };
  const createBrowserTab = vi.fn(async () => opened);
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply: freshRouteTabReply(tabReply, opened),
    createBrowserTab,
    queryProviderTabs: async () => [unclaimed],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: fastFreshRoute
  });
  const conversationId = 'ds-11111111-1111-4111-8111-111111111111';
  await chrome.storage.local.set({
    webProviderTabs: { [conversationId]: { provider: 'deepseek', tab: 99, at: Date.now() - 86_400_000 } }
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000099',
    provider: 'deepseek',
    conversationId,
    text: 'continue yesterday',
    fresh: false
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('follow-up on a new tab')
  })));
  expect(createBrowserTab).toHaveBeenCalled();
});

it('opens a new DeepSeek tab when a follow-up chat lost its original tab', async () => {
  const claimed = { id: 22, url: 'https://chat.deepseek.com/', status: 'complete' };
  const opened = { id: 99, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const tabReply = vi.fn(async (id: number, message: { type: string; fresh?: boolean }) => {
    if (id === 22) {
      return { signedIn: true, generating: false, conversationId: 'ds-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', before: 'other chat' };
    }
    if (message.type === 'neuraflok-deepseek-status' || message.type === 'neuraflok-deepseek-snapshot') {
      return { signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '' };
    }
    if (message.type === 'neuraflok-deepseek-complete') {
      expect(message.fresh).toBe(true);
      return { text: 'reconnected on a new DeepSeek chat' };
    }
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async (id: number) => {
      if (id === 99) return opened;
      throw new Error('tab gone');
    }) }
  };
  const createBrowserTab = vi.fn(async () => opened);
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply: freshRouteTabReply(tabReply, opened),
    createBrowserTab,
    queryProviderTabs: async () => [claimed],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: fastFreshRoute
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000095',
    provider: 'deepseek',
    conversationId: 'ds-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    text: 'BIEN QUE MAS CREES TU QUE PODEMOS AGREGAR',
    fresh: false
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('reconnected on a new DeepSeek chat')
  })));
  expect(createBrowserTab).toHaveBeenCalled();
});

it('does not steal a DeepSeek tab that already belongs to another local session', async () => {
  const claimed = { id: 22, url: 'https://chat.deepseek.com/', title: 'DeepSeek', status: 'complete' };
  const opened = { id: 99, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const tabReply = vi.fn(async (id: number, message: { type: string; fresh?: boolean }) => {
    if (id === 22) throw new Error('must not steal another session tab');
    if (message.type === 'neuraflok-deepseek-status' || message.type === 'neuraflok-deepseek-snapshot') {
      return { signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '' };
    }
    if (message.type === 'neuraflok-deepseek-complete') {
      expect(message.fresh).toBe(true);
      return { text: 'sent on a new DeepSeek tab' };
    }
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async (id: number) => {
      if (id === 99) return opened;
      throw new Error('tab gone');
    }) }
  };
  const createBrowserTab = vi.fn(async () => opened);
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply: freshRouteTabReply(tabReply, opened),
    createBrowserTab,
    queryProviderTabs: async () => [claimed],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: fastFreshRoute
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000098',
    provider: 'deepseek',
    conversationId: 'ds-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    text: 'hello',
    fresh: false
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('sent on a new DeepSeek tab')
  })));
  expect(createBrowserTab).toHaveBeenCalled();
  expect(JSON.stringify(call.mock.calls)).not.toMatch(/no longer belongs|no verified browser tab/i);
});

it('restores the DeepSeek tab when status times out instead of failing the turn', async () => {
  const tab = { id: 23, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const restoreDeepseekTab = vi.fn(async () => true);
  let statusCalls = 0;
  const tabReply = vi.fn(async (_id: number, message: { type: string }) => {
    if (message.type === 'neuraflok-deepseek-status') {
      statusCalls += 1;
      if (statusCalls === 1) throw new Error('provider_page_timeout');
      return { signedIn: true, generating: false, conversationId: null, before: '' };
    }
    if (message.type === 'neuraflok-deepseek-snapshot') {
      return { signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '' };
    }
    if (message.type === 'neuraflok-deepseek-complete') return { text: 'restored after timeout' };
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async () => tab) }
  };
  const conversationId = 'ds-22222222-2222-4222-8222-222222222222';
  await chrome.storage.local.set({
    webProviderTabs: { [conversationId]: { provider: 'deepseek', tab: 23, at: Date.now() } }
  });
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply,
    createBrowserTab: async () => tab,
    queryProviderTabs: async () => [tab],
    restoreDeepseekTab,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome)
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000097',
    provider: 'deepseek',
    conversationId,
    text: 'CONTINUA',
    fresh: false
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('restored after timeout')
  })));
  expect(restoreDeepseekTab).toHaveBeenCalled();
  expect(JSON.stringify(call.mock.calls)).not.toMatch(/provider_page_timeout/);
});

it('watches the DeepSeek tab when complete times out after the send was claimed', async () => {
  vi.useFakeTimers();
  try {
    const tab = { id: 24, url: 'https://chat.deepseek.com/', status: 'complete' };
    const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
    const tabReply = vi.fn(async (_id: number, message: { type: string }) => {
      if (message.type === 'neuraflok-deepseek-status' || message.type === 'neuraflok-deepseek-snapshot') {
        return { signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '' };
      }
      if (message.type === 'neuraflok-deepseek-complete') throw new Error('provider_page_timeout');
      if (message.type === 'neuraflok-deepseek-read') {
        return {
          generating: false, canContinue: false,
          answer: 'continued the tree work', think: '', text: 'continued the tree work'
        };
      }
      return null;
    });
    const chrome = {
      storage: { local: memoryStorage(), session: memoryStorage() },
      tabs: { get: vi.fn(async () => tab) }
    };
    const conversationId = 'ds-33333333-3333-4333-8333-333333333333';
    await chrome.storage.local.set({
      webProviderTabs: { [conversationId]: { provider: 'deepseek', tab: 24, at: Date.now() } }
    });
    const executor = createDeepseekPageExecutor({
      chrome: chrome as never,
      activeTabs: { set: vi.fn(async () => undefined) } as never,
      call,
      tabReply,
      createBrowserTab: async () => tab,
      queryProviderTabs: async () => [tab],
      restoreDeepseekTab: async () => true,
      waitForTabReady: async () => undefined,
      isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
      usableProviderTab: () => true,
      state: createProviderPageState(chrome)
    });
    executor.inspect({
      id: '00000000-0000-4000-8000-000000000096',
      provider: 'deepseek',
      conversationId,
      text: 'CONTINUA',
      fresh: false
    }, false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
      body: expect.stringContaining('continued the tree work')
    }));
    expect(JSON.stringify(call.mock.calls)).not.toMatch(/provider_page_timeout/);
  } finally {
    vi.useRealTimers();
  }
});

it('fails fast when a fresh general chat stays on a blank DeepSeek page', async () => {
  vi.useFakeTimers();
  const { watchDeepseekReply, posted } = watchHarness([
    { generating: false, canContinue: false, answer: '', think: '', text: '' }
  ]);
  const running = watchDeepseekReply(7, {
    ...offer,
    fresh: true,
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola'
  }, '', '', '');
  await vi.advanceTimersByTimeAsync(25_000);
  await running;
  expect(posted.at(-1)).toMatchObject({
    error: expect.stringMatching(/did not send this message/i)
  });
});

it('types after New chat even when leftover recap still paints on the signed-in page', async () => {
  const leftover = 'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.';
  const tab = { id: 47, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const completes: Array<{ fresh?: boolean; before?: string }> = [];
  const tabReply = vi.fn(async (_id: number, message: { type: string; fresh?: boolean; before?: string }) => {
    if (message.type === 'neuraflok-deepseek-status' || message.type === 'neuraflok-deepseek-snapshot') {
      return { signedIn: true, generating: false, conversationId: null, freshConversation: true, hasConversation: false, before: leftover, beforeThink: '', answer: leftover };
    }
    if (message.type === 'neuraflok-deepseek-complete') {
      completes.push({ fresh: message.fresh, before: message.before });
      if (message.fresh === true) return { pending: true, openedNewChat: true };
      return { text: 'Hola. ¿En qué te ayudo?', before: leftover };
    }
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async () => tab) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply: freshRouteTabReply(tabReply, tab),
    createBrowserTab: async () => tab,
    queryProviderTabs: async () => [],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: fastFreshRoute
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000104',
    provider: 'deepseek',
    conversationId: 'ds-44444444-4444-4444-8444-444444444444',
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola',
    fresh: true
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('Hola. ¿En qué te ayudo?')
  })));
  expect(JSON.stringify(call.mock.calls)).not.toMatch(/did not send this message/i);
  expect(completes.map((row) => row.fresh)).toEqual([true, false]);
  expect(completes[1]?.before).toMatch(/descuento dinámico/i);
});

it('resends on a blank signed-in page after New chat unloads the content script', async () => {
  const tab = { id: 42, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const completes: Array<{ fresh?: boolean }> = [];
  const tabReply = vi.fn(async (_id: number, message: { type: string; fresh?: boolean }) => {
    if (message.type === 'neuraflok-deepseek-status' || message.type === 'neuraflok-deepseek-snapshot') {
      return { signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '', answer: '' };
    }
    if (message.type === 'neuraflok-deepseek-complete') {
      completes.push({ fresh: message.fresh });
      if (message.fresh === true) return { pending: true, openedNewChat: true };
      return { text: 'zingprobe77' };
    }
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async () => tab) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply: freshRouteTabReply(tabReply, tab),
    createBrowserTab: async () => tab,
    queryProviderTabs: async () => [],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: fastFreshRoute
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000098',
    provider: 'deepseek',
    conversationId: 'ds-55555555-5555-4555-8555-555555555556',
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola',
    fresh: true
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('zingprobe77')
  })));
  expect(completes).toEqual([{ fresh: true }, { fresh: false }]);
});

it('recovers a provider reply after complete times out without resending', async () => {
  const tab = { id: 41, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const completes: Array<{ fresh?: boolean }> = [];
  let sent = false;
  const tabReply = vi.fn(async (_id: number, message: { type: string; fresh?: boolean }) => {
    if (message.type === 'neuraflok-deepseek-status'
      || message.type === 'neuraflok-deepseek-snapshot'
      || message.type === 'neuraflok-deepseek-read') {
      if (sent) {
        return {
          signedIn: true, generating: false, canContinue: false, conversationId: null,
          before: '', beforeThink: '', answer: 'pinglive42', text: 'pinglive42',
          hasConversation: true, freshConversation: false, newChatRoute: false
        };
      }
      return { signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '', answer: '' };
    }
    if (message.type === 'neuraflok-deepseek-complete') {
      completes.push({ fresh: message.fresh });
      sent = true;
      if (message.fresh === true) throw new Error('provider_page_timeout');
      return { text: 'pinglive42' };
    }
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async () => tab) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply: freshRouteTabReply(tabReply, tab),
    createBrowserTab: async () => tab,
    queryProviderTabs: async () => [],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: fastFreshRoute
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000097',
    provider: 'deepseek',
    conversationId: 'ds-55555555-5555-4555-8555-555555555555',
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola',
    fresh: true
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('pinglive42')
  })));
  expect(completes).toEqual([{ fresh: true }]);
});

it('opens a new DeepSeek tab when the home tab still shows a previous conversation', async () => {
  const leftover = { id: 44, url: 'https://chat.deepseek.com/', status: 'complete' };
  const opened = { id: 88, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const createBrowserTab = vi.fn(async () => opened);
  const tabReply = vi.fn(async (id: number, message: { type: string }) => {
    if (id === 44) {
      return { signedIn: true, generating: false, conversationId: 'ds-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', before: 'previous project reply', answer: 'previous project reply' };
    }
    if (message.type === 'neuraflok-deepseek-status' || message.type === 'neuraflok-deepseek-snapshot') {
      return { signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '', answer: '' };
    }
    if (message.type === 'neuraflok-deepseek-complete') return { text: 'new reply' };
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async (id: number) => id === 88 ? opened : leftover) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply: freshRouteTabReply(tabReply, opened),
    createBrowserTab,
    queryProviderTabs: async () => [leftover],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: fastFreshRoute
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000102',
    provider: 'deepseek',
    conversationId: 'ds-88888888-8888-4888-8888-888888888888',
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola',
    fresh: true
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('new reply')
  })));
  expect(createBrowserTab).toHaveBeenCalled();
});

it('opens a new DeepSeek tab even when a signed-in home tab already exists', async () => {
  const home = { id: 44, url: 'https://chat.deepseek.com/', title: 'DeepSeek', status: 'complete' };
  const opened = { id: 91, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const createBrowserTab = vi.fn(async () => opened);
  const tabReply = vi.fn(async (id: number, message: { type: string }) => {
    if (id === 44) throw new Error('must not reuse an existing DeepSeek home tab');
    if (message.type === 'neuraflok-deepseek-status' || message.type === 'neuraflok-deepseek-snapshot') {
      return { signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '' };
    }
    if (message.type === 'neuraflok-deepseek-complete') return { text: 'zingok93' };
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async (id: number) => id === 91 ? opened : home) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply: freshRouteTabReply(tabReply, opened),
    createBrowserTab,
    queryProviderTabs: async () => [home],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: fastFreshRoute
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000100',
    provider: 'deepseek',
    conversationId: 'ds-66666666-6666-4666-8666-666666666666',
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola',
    fresh: true
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('zingok93')
  })));
  expect(createBrowserTab).toHaveBeenCalled();
});

it('does not pick among DeepSeek tabs that share the same title', async () => {
  const first = { id: 51, url: 'https://chat.deepseek.com/a/chat/s/old-one', title: 'DeepSeek', status: 'complete' };
  const second = { id: 52, url: 'https://chat.deepseek.com/a/chat/s/old-two', title: 'DeepSeek', status: 'complete' };
  const opened = { id: 53, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const createBrowserTab = vi.fn(async () => opened);
  const tabReply = vi.fn(async (id: number, message: { type: string }) => {
    if (id === 51 || id === 52) throw new Error('must not search existing DeepSeek tabs by title');
    if (message.type === 'neuraflok-deepseek-status' || message.type === 'neuraflok-deepseek-snapshot') {
      return { signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '' };
    }
    if (message.type === 'neuraflok-deepseek-complete') return { text: 'hola en pestaña nueva' };
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async (id: number) => {
      if (id === 53) return opened;
      if (id === 51) return first;
      if (id === 52) return second;
      throw new Error('tab gone');
    }) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply: freshRouteTabReply(tabReply, opened),
    createBrowserTab,
    queryProviderTabs: async () => [first, second],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: fastFreshRoute
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000103',
    provider: 'deepseek',
    conversationId: 'ds-99999999-9999-4999-8999-999999999999',
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola',
    fresh: true
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringContaining('hola en pestaña nueva')
  })));
  expect(createBrowserTab).toHaveBeenCalledWith('https://chat.deepseek.com/', false);
});

it('does not resubmit an ambiguous fresh send timeout', async () => {
  const tab = { id: 45, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const completes: boolean[] = [];
  let sent = false;
  const tabReply = vi.fn(async (_id: number, message: { type: string; fresh?: boolean }) => {
    if (message.type === 'neuraflok-deepseek-status'
      || message.type === 'neuraflok-deepseek-snapshot'
      || message.type === 'neuraflok-deepseek-read') {
      if (sent) {
        return {
          signedIn: true, generating: false, canContinue: false, conversationId: null,
          before: '', beforeThink: '', answer: '', text: '', hasConversation: false,
          freshConversation: true, newChatRoute: true
        };
      }
      return { signedIn: true, generating: false, conversationId: null, before: '', beforeThink: '', answer: '' };
    }
    if (message.type === 'neuraflok-deepseek-complete') {
      completes.push(message.fresh === true);
      sent = true;
      throw new Error('provider_page_timeout');
    }
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async () => tab) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply: freshRouteTabReply(tabReply, tab),
    createBrowserTab: async () => tab,
    queryProviderTabs: async () => [],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: fastFreshRoute,
    watchTimings: { watchMs: 35, pollMs: 1, generalPollMs: 1, readMs: 5, maxResumes: 0 }
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000101',
    provider: 'deepseek',
    conversationId: 'ds-77777777-7777-4777-8777-777777777777',
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola',
    fresh: true
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringMatching(/did not finish this reply in time/i)
  })));
  expect(completes).toEqual([true]);
});

it('does not treat a blank DeepSeek home as fresh before New chat is activated', async () => {
  const tab = { id: 48, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const completes: boolean[] = [];
  const tabReply = vi.fn(async (_id: number, message: { type: string; fresh?: boolean }) => {
    if (message.type === 'neuraflok-deepseek-status' || message.type === 'neuraflok-deepseek-snapshot') {
      return {
        signedIn: true, generating: false, conversationId: null,
        before: '', beforeThink: '', answer: '',
        freshConversation: true, hasConversation: false, newChatRoute: false, newChatAvailable: true
      };
    }
    if (message.type === 'neuraflok-deepseek-open-new-chat') return { started: true };
    if (message.type === 'neuraflok-deepseek-complete') {
      completes.push(message.fresh === true);
      throw new Error('provider_page_timeout');
    }
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async () => tab) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply,
    createBrowserTab: async () => tab,
    queryProviderTabs: async () => [],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: { pollMs: 1, signedSettleMs: 0, freshRouteStableMs: 2, freshRouteTimeoutMs: 15 }
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000106',
    provider: 'deepseek',
    conversationId: 'ds-ffffffff-ffff-4fff-8fff-ffffffffffff',
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola',
    fresh: true
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringMatching(/confirm a stable new chat/i)
  })));
  expect(completes).toEqual([]);
});

it('fails safely when DeepSeek stays on the previous conversation before the fresh send', async () => {
  const previous = 'Respuesta previa del proyecto con el archivo tienda.ts y el resumen del trabajo de ayer.';
  const tab = { id: 46, url: 'https://chat.deepseek.com/', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const completes: Array<boolean | undefined> = [];
  const tabReply = vi.fn(async (_id: number, message: { type: string; fresh?: boolean }) => {
    if (message.type === 'neuraflok-deepseek-status' || message.type === 'neuraflok-deepseek-snapshot') {
      return {
        signedIn: true, generating: false, conversationId: null, hasConversation: true,
        freshConversation: false, newChatRoute: false, newChatAvailable: true,
        before: previous, beforeThink: '', answer: previous
      };
    }
    if (message.type === 'neuraflok-deepseek-open-new-chat') {
      return { started: true };
    }
    if (message.type === 'neuraflok-deepseek-complete') {
      completes.push(message.fresh);
      throw new Error('provider_page_timeout');
    }
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async () => tab) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply,
    createBrowserTab: async () => tab,
    queryProviderTabs: async () => [],
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    usableProviderTab: () => true,
    state: createProviderPageState(chrome),
    snapshotTimings: { pollMs: 1, signedSettleMs: 0, freshRouteStableMs: 2, freshRouteTimeoutMs: 15 }
  });
  executor.inspect({
    id: '00000000-0000-4000-8000-000000000105',
    provider: 'deepseek',
    conversationId: 'ds-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nHola',
    fresh: true
  }, false);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringMatching(/confirm a stable new chat/i)
  })));
  expect(completes).toEqual([]);
  expect(JSON.stringify(call.mock.calls)).not.toMatch(/Hola\. ¿En qué te ayudo\?/);
});

it('does not send while DeepSeek restores the previous thread during route stabilization', async () => {
  const previous = 'Respuesta anterior del proyecto con el resumen de ayer.';
  const tab = { id: 47, url: 'https://chat.deepseek.com/a/chat/s/new-conversation', status: 'complete' };
  const call = vi.fn(async () => ({ ok: true, data: { ok: true } }));
  const completes: boolean[] = [];
  let snapshots = 0;
  const tabReply = vi.fn(async (_id: number, message: { type: string; fresh?: boolean }) => {
    if (message.type === 'neuraflok-deepseek-status') {
      return { signedIn: true, generating: false, conversationId: null };
    }
    if (message.type === 'neuraflok-deepseek-snapshot') {
      snapshots += 1;
      if (snapshots === 1) {
        return {
          signedIn: true, generating: false, conversationId: null,
          newChatRoute: true, freshConversation: true, hasConversation: false,
          before: '', beforeThink: '', answer: ''
        };
      }
      return {
        signedIn: true, generating: false, conversationId: null,
        newChatRoute: false, freshConversation: false, hasConversation: true,
        before: previous, beforeThink: '', answer: previous
      };
    }
    if (message.type === 'neuraflok-deepseek-complete') {
      completes.push(message.fresh === true);
      throw new Error('provider_page_timeout');
    }
    if (message.type === 'neuraflok-deepseek-open-new-chat') return { started: true };
    return null;
  });
  const chrome = {
    storage: { local: memoryStorage(), session: memoryStorage() },
    tabs: { get: vi.fn(async () => tab) }
  };
  const executor = createDeepseekPageExecutor({
    chrome: chrome as never,
    activeTabs: { set: vi.fn(async () => undefined) } as never,
    call,
    tabReply,
    createBrowserTab: async () => tab,
    restoreDeepseekTab: async () => true,
    waitForTabReady: async () => undefined,
    isDeepseekUrl: (url: string) => String(url).includes('deepseek'),
    state: createProviderPageState(chrome),
    snapshotTimings: { pollMs: 1, signedSettleMs: 0, freshRouteStableMs: 10, freshRouteTimeoutMs: 20 }
  });

  executor.inspect({
    id: '00000000-0000-4000-8000-000000000106',
    provider: 'deepseek',
    conversationId: 'ds-12121212-1212-4212-8212-121212121212',
    text: 'This is a conversation only. Answer the user directly in ordinary prose.\n\nSigue con el contexto anterior.',
    fresh: true
  }, false);

  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
    body: expect.stringMatching(/confirm a stable new chat/i)
  })));
  expect(completes).toEqual([]);
});
