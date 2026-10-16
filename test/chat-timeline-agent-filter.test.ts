import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../contracts/session.js';
import type { AppState } from '../contracts/types.js';
import { createChatTimelineAgentFilter, type ChatTimelineAgentFilterRuntime } from '../frontend/features/chat/chat-timeline-agent-filter.js';

let dom: JSDOM | null = null;

afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.unstubAllGlobals();
});

function fixture(developerMode: boolean) {
  dom = new JSDOM('<div id="chatAgentFilter"></div>');
  vi.stubGlobal('document', dom.window.document);
  const events = [
    { kind: 'user_message', agent: 'agent-a' },
    { kind: 'assistant_message', agent: 'agent-b' },
    { kind: 'tool_call' },
  ] as SessionEvent[];
  const runtime: ChatTimelineAgentFilterRuntime = {
    events,
    selectedId: 'session-a',
    agentFilter: 'agent-a',
    filterFor: 'session-a',
    UNATTRIBUTED: '__unattributed__',
    state: () => ({ config: { ui: { developerMode } } }) as AppState,
  };
  return { runtime, filter: createChatTimelineAgentFilter(runtime), box: dom.window.document.getElementById('chatAgentFilter')! };
}

it('renders attribution choices and filters events without changing their order', () => {
  const { runtime, filter, box } = fixture(true);
  filter.paintAgentFilter();

  expect([...box.querySelectorAll('button')].map(button => button.textContent)).toEqual([
    'All', 'agent-a', 'agent-b', 'Unattributed',
  ]);
  expect(filter.visibleEvents()).toEqual([runtime.events[0]]);
  runtime.agentFilter = runtime.UNATTRIBUTED;
  expect(filter.visibleEvents()).toEqual([runtime.events[2]]);
  runtime.agentFilter = null;
  expect(filter.visibleEvents()).toBe(runtime.events);
});

it('hides filters in standard mode and resets a filter when its session changes', () => {
  const { runtime, filter, box } = fixture(false);
  filter.paintAgentFilter();
  expect(box.hidden).toBe(true);
  expect(runtime.agentFilter).toBeNull();

  runtime.state = () => ({ config: { ui: { developerMode: true } } }) as AppState;
  runtime.agentFilter = 'agent-a';
  runtime.filterFor = 'session-a';
  runtime.selectedId = 'session-b';
  filter.paintAgentFilter();
  expect(runtime.agentFilter).toBeNull();
  expect(runtime.filterFor).toBe('session-b');
});
