export interface ChatInputNoticeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ChatInputNoticeDismissalDependencies {
  storage: () => ChatInputNoticeStorage;
  refreshInputQueue: () => Promise<void>;
}

const INPUT_NOTICE_KEY = 'dismissed-input-notices';

export function createChatInputNoticeDismissals(dependencies: ChatInputNoticeDismissalDependencies) {
  const dismissedInputNotices = new Set<string>((() => {
    try {
      const saved: unknown = JSON.parse(dependencies.storage().getItem(INPUT_NOTICE_KEY) ?? '[]');
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string' && id.length <= 64).slice(-100) : [];
    } catch {
      return [];
    }
  })());

  function dismissInputNotice(id: string): void {
    dismissedInputNotices.add(id);
    try {
      dependencies.storage().setItem(INPUT_NOTICE_KEY, JSON.stringify([...dismissedInputNotices].slice(-100)));
    } catch {
      // A storage failure still allows dismissal for this window lifetime.
    }
    void dependencies.refreshInputQueue();
  }

  return { dismissedInputNotices, dismissInputNotice };
}
