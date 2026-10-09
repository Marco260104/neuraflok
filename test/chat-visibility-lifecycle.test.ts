import { describe, expect, it, vi } from 'vitest';
import { createChatVisibilityLifecycle } from '../frontend/features/chat/chat-visibility-lifecycle.js';

const swarm = { enabled: true, running: false, agents: [] };

describe('chat visibility lifecycle', () => {
  it('refreshes sessions before painting the swarm when opened', async () => {
    const order: string[] = [];
    const lifecycle = createChatVisibilityLifecycle({
      loadSessions: async () => { order.push('sessions'); },
      loadSwarm: async () => { order.push('swarm'); return swarm; },
      paintSwarm: state => { order.push(state === swarm ? 'paint' : 'wrong-state'); },
      stopToolActivityExpiry: vi.fn(),
      clearDurationTimer: vi.fn()
    });

    lifecycle.setVisible(true);
    await vi.waitFor(() => expect(order).toEqual(['sessions', 'swarm', 'paint']));
    expect(lifecycle.visible).toBe(true);
  });

  it('ignores repeated visibility and stops window-local timers when hidden', () => {
    const loadSessions = vi.fn(async () => {});
    const stopToolActivityExpiry = vi.fn();
    const clearDurationTimer = vi.fn();
    const lifecycle = createChatVisibilityLifecycle({
      loadSessions,
      loadSwarm: async () => null,
      paintSwarm: vi.fn(),
      stopToolActivityExpiry,
      clearDurationTimer
    });

    lifecycle.setVisible(false);
    lifecycle.setVisible(true);
    lifecycle.setVisible(true);
    lifecycle.setVisible(false);

    expect(loadSessions).toHaveBeenCalledOnce();
    expect(stopToolActivityExpiry).toHaveBeenCalledOnce();
    expect(clearDurationTimer).toHaveBeenCalledOnce();
    expect(lifecycle.visible).toBe(false);
  });

  it('does not paint an unavailable swarm', async () => {
    const paintSwarm = vi.fn();
    const lifecycle = createChatVisibilityLifecycle({
      loadSessions: async () => {},
      loadSwarm: async () => null,
      paintSwarm,
      stopToolActivityExpiry: vi.fn(),
      clearDurationTimer: vi.fn()
    });

    await lifecycle.refreshAll();

    expect(paintSwarm).not.toHaveBeenCalled();
  });
});
