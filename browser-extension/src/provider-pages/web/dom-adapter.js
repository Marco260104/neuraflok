// Semantic DOM adapters serve Kimi, Qwen, and Z AI while DeepSeek keeps its own adapter.
(() => {
  const host = location.hostname.toLowerCase();
  const provider = host === 'www.kimi.com' || host === 'kimi.com' ? 'kimi'
    : host === 'chat.qwen.ai' ? 'qwen'
      : host === 'z.ai' || host === 'chat.z.ai' || host === 'chatglm.cn' || host === 'www.chatglm.cn' ? 'glm' : null;
  if (!provider) return;

  const visible = (node) => {
    if (!node || node.disabled || node.getAttribute?.('aria-disabled') === 'true' || node.hasAttribute?.('disabled')) return false;
    const classList = node.classList ? [...node.classList] : [];
    if (classList.some((c) => /disabled/i.test(c))) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  };
  const textOf = (node) => String(node?.innerText || node?.textContent || '').replace(/\u00a0/g, ' ').trim();
  const labelOf = (node) => `${node?.getAttribute?.('aria-label') || ''} ${node?.getAttribute?.('title') || ''} ${textOf(node)}`.replace(/\s+/g, ' ').trim();
  const controls = () => [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(visible);
  const composer = () => {
    const candidates = controls().filter((node) => {
      if (node.matches?.('input[type="search"], input[type="password"]')) return false;
      const label = `${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('placeholder') || ''}`.toLowerCase();
      return !/search|搜索|搜尋|検索/.test(label);
    });
    return candidates[candidates.length - 1] || null;
  };
  const sendButton = () => {
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
    return buttons.find((node) => /^(send|submit|ask|enviar|envoyer|senden|发送|傳送|送信|보내기|发送消息|发送訊息)$/i.test(labelOf(node)))
      || buttons.find((node) => /send|submit|发送|傳送|送信|보내기/i.test(`${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''}`))
      || buttons.find((node) => /send|submit|arrow-up|paper-plane/i.test(`${node.className || ''} ${node.getAttribute?.('data-testid') || ''} ${node.innerHTML || ''}`))
      || null;
  };
  const stopButton = () => [...document.querySelectorAll('button, [role="button"]')].filter(visible)
    .find((node) => {
      const label = labelOf(node);
      if (/stop|cancel|停止|取消|중지|arrêter/i.test(label)) return true;
      const attr = `${node.className || ''} ${node.getAttribute?.('data-testid') || ''} ${node.getAttribute?.('aria-label') || ''}`.toLowerCase();
      if (/stop|square/i.test(attr)) return true;
      if (node.querySelector('svg rect, svg [class*="stop" i], [class*="square" i]')) return true;
      return false;
    }) || null;
  const messageCandidates = () => {
    const preferred = [...document.querySelectorAll(
      '[data-message-author-role="assistant"], [data-role="assistant"], [data-role="bot"], ' +
      '[class*="assistant" i] [class*="markdown" i], [class*="assistant" i] .markdown-body, ' +
      '[class*="bot" i] [class*="markdown" i], [class*="ai" i] [class*="markdown" i], ' +
      '[class*="assistant" i] [class*="content" i], [class*="bot" i] [class*="content" i], ' +
      '[class*="answer" i] [class*="content" i], [class*="response" i]'
    )].filter(visible);
    if (preferred.length) return preferred;
    return [...document.querySelectorAll(
      '[data-message-author-role], [data-role], .markdown-body, [class*="markdown" i], [class*="message-content" i], [class*="chat-message" i]'
    )].filter(visible);
  };
  const hasConversation = () => [...document.querySelectorAll(
    '[data-message-author-role], [data-role="user"], [data-role="assistant"], [class*="message-item"], [class*="message-content"]'
  )].some((node) => visible(node) && Boolean(textOf(node)));
  const lastAnswer = () => {
    const candidates = messageCandidates();
    for (let index = candidates.length - 1; index >= 0; index--) {
      const node = candidates[index];
      const roleNode = node.closest?.('[data-message-author-role], [data-role]');
      const owner = `${node.className || ''} ${node.parentElement?.className || ''} ${roleNode?.getAttribute?.('data-message-author-role') || ''} ${roleNode?.getAttribute?.('data-role') || ''}`.toLowerCase();
      if (/user|human|prompt|question/.test(owner)) continue;
      const text = textOf(node);
      if (text) return text;
    }
    return '';
  };
  const setValue = (node, value) => {
    node.focus();
    if (node.isContentEditable || node.getAttribute?.('contenteditable') === 'true') {
      const selection = window.getSelection?.();
      const range = document.createRange?.();
      if (selection && range) {
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, value);
      if (!inserted) node.textContent = value;
    } else {
      const view = node.ownerDocument?.defaultView || window;
      const proto = node.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(node, value); else node.value = value;
    }
    try {
      node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: value }));
    } catch {}
    try {
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    } catch {
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }
    node.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const newChat = () => [...document.querySelectorAll('a[href], button, [role="button"]')].filter(visible)
    .find((node) => /new chat|new conversation|nuevo chat|nueva conversación|nouveau chat|neuer chat|新建聊天|新建会话|新对话|新對話|新しいチャット|새 채팅/i.test(labelOf(node))) || null;

  const api = {
    provider,
    composer,
    sendButton,
    stopButton,
    generating: () => {
      if (Boolean(stopButton())) return true;
      return Boolean(document.querySelector(
        '[class*="cursor" i], [class*="typing" i], [class*="generating" i], [class*="loading-dot" i], .dot-flashing, [data-testid*="loading" i], [class*="spin" i], [class*="animate-spin" i]'
      ));
    },
    lastAnswer,
    lastThink: () => '',
    hasConversation,
    setValue,
    newChat,
    signedIn: () => {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = (localStorage.key(i) || '').toLowerCase();
          if (/(token|auth|user|session|account)/i.test(key)) {
            const val = localStorage.getItem(localStorage.key(i) || '');
            if (val && val.length > 8 && val !== 'null' && val !== 'undefined' && val !== '{}') return true;
          }
        }
      } catch {}

      if (document.querySelector(
        '[class*="avatar" i], [class*="profile" i], [class*="account" i], [class*="user" i], ' +
        '[data-testid*="user" i], [data-testid*="profile" i], [data-testid*="avatar" i], ' +
        'img[src*="avatar" i], img[alt*="avatar" i], [aria-label*="user" i], [aria-label*="profile" i]'
      )) {
        return true;
      }

      const loginOverlay = [...document.querySelectorAll('[role="dialog"], .modal, [class*="modal" i], [class*="login" i], [class*="auth" i]')].find(visible);
      if (loginOverlay && /sign in|log in|登录|登入|login|auth/i.test(labelOf(loginOverlay))) {
        return false;
      }

      const loginButtons = [...document.querySelectorAll('a, button, [role="button"]')].filter(visible)
        .filter((node) => /^(sign in|log in|login|signin|register|sign up|signup|登录|登入|注册|註冊)$/i.test(labelOf(node)));
      if (loginButtons.length) return false;

      const box = composer();
      if (box && !box.disabled && box.getAttribute?.('aria-disabled') !== 'true') return true;

      if (location.pathname.includes('/chat') || location.pathname.includes('/main') || location.pathname === '/') {
        return true;
      }

      return false;
    }
  };
  // Re-injection happens on SPA route changes. Keep the adapter identity that
  // the already-installed delivery listener captured, and update its methods.
  const current = globalThis.NEURAFLOK_PROVIDER;
  if (current && current.provider === provider) Object.assign(current, api);
  else globalThis.NEURAFLOK_PROVIDER = api;
})();
