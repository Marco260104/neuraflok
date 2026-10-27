// Detect DeepSeek composer, conversation, answer, and send controls.
var NEURAFLOK_DEEPSEEK = (() => {
  const SEND_PATH = 'M8.3125 0.98';
  const STOP_PATH = 'M2 4.88';
  const ATTACH_PATH = 'M5.5498';
  const SEND_LABEL = /^(send|enviar|envoyer|senden|送信|发送|傳送|보내기)$/i;
  const STOP_LABEL = /^(stop|cancel|detener|parar|停止|중지|arrêt|остановить)$/i;
  const NEW_CHAT_LABEL = /new chat|start (?:a )?new chat|new conversation|start (?:a )?new conversation|nuevo chat|nueva conversación|iniciar (?:un )?chat nuevo|nouvelle conversation|nouveau chat|neuer chat|neue unterhaltung|新しいチャット|新しい会話|新建对话|新对话|新聊天|新建聊天|新對話|새 채팅/i;
  const NEW_CHAT_EXACT_TEXT = /^(?:new chat|start (?:a )?new chat|new conversation|start (?:a )?new conversation|nuevo chat|nueva conversación|iniciar (?:un )?chat nuevo|nouvelle conversation|nouveau chat|neuer chat|neue unterhaltung|新しいチャット|新しい会話|新建对话|新对话|新聊天|新建聊天|新對話|새 채팅)$/i;
  const NEW_CHAT_PATH = /\/(?:a\/)?chat\/(?:s\/)?new|\/new[-/]?conversation/i;
  const CONTINUE_LABEL = /continue generating|continuar generando|continuer à générer|weiter generieren|生成を続ける|继续生成|계속 생성/i;
  const CONTINUE_EXACT = /^(continue|continuar|continuer|fortsetzen|続き|继续|계속)$/i;
  const CONTINUE_WORD = /\b(continue generating|continuar generando|continuar|continue|reintentar|retry|regenerate|try again)\b/i;
  const RETRY_LABEL = /retry|reintentar|regenerate|regenerar|try again|volver a intentar|réessayer|reessayer|erneut versuchen|再試行|重试|다시 시도/i;
  const SERVER_ERROR = /server (is )?busy|temporarily unavailable|servidor no (está |esta )?disponible|please try again later|the server is busy|too many requests|el servidor (está|esta) ocupado/i;
  const THINK_STOPPED = /^(detenido|stopped|interrupted|已停止)\b/i;
  const SIDEBAR_CONTINUE = /sesi[oó]n|session|chat anterior|nuevo chat|new chat/i;

  const safe = (fn, fallback) => {
    try {
      const value = fn();
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  };

  const pathOf = (button) => button?.querySelector?.('svg path')?.getAttribute?.('d') || '';
  const visible = (node) => {
    if (!node) return false;
    if (node.getAttribute?.('aria-disabled') === 'true' || node.disabled === true || node.hasAttribute?.('disabled')) return false;
    const classList = node.classList ? [...node.classList] : [];
    if (classList.some((c) => /disabled/i.test(c))) return false;
    const rects = typeof node.getClientRects === 'function' ? node.getClientRects() : [];
    return rects.length > 0;
  };
  const labelOf = (node) => [
    node?.getAttribute?.('aria-label'),
    node?.getAttribute?.('aria-description'),
    node?.getAttribute?.('title'),
    node?.getAttribute?.('data-testid'),
    node?.getAttribute?.('data-tooltip-content'),
    node?.getAttribute?.('data-tooltip'),
    node?.getAttribute?.('id'),
    node?.className,
    node?.textContent
  ].filter(Boolean).join(' ').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

  const onPage = (node) => {
    if (!node) return false;
    const rects = typeof node.getClientRects === 'function' ? node.getClientRects() : [];
    return rects.length > 0;
  };

  const visibleButtons = () => [...document.querySelectorAll('button, [role="button"]')].filter(visible);

  const circleButtons = () => visibleButtons().filter((button) => pathOf(button));

  const buttonFor = (prefix) => circleButtons().find((button) => {
    const path = pathOf(button);
    return path.startsWith(prefix) && !path.startsWith(ATTACH_PATH);
  }) || null;

  const classListOf = (button) => String(button?.className || '').split(/\s+/);
  const primaryCircle = () => circleButtons().find((button) => {
    const names = classListOf(button);
    if (!names.includes('ds-button--primary') || !names.includes('ds-button--circle')) return false;
    const path = pathOf(button);
    return !path.startsWith(STOP_PATH) && !path.startsWith(ATTACH_PATH);
  }) || null;

  const labeledButton = (pattern) => visibleButtons().find((button) => pattern.test(labelOf(button))) || null;

  const composer = () =>
    document.querySelector('textarea#chat-input') ||
    document.querySelector('textarea[name="search"]') ||
    document.querySelector('.ds-input textarea') ||
    document.querySelector('div[class*="chat-input"] textarea') ||
    document.querySelector('textarea') ||
    null;

  const setValue = (textarea, text) => {
    try {
      textarea.focus();
      textarea.select?.();
    } catch {}
    let inserted = false;
    try {
      inserted = document.execCommand?.('insertText', false, text) === true;
    } catch {}
    if (!inserted || textarea.value !== text) {
      const tracker = textarea._valueTracker;
      const proto = Object.getPrototypeOf(textarea);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      if (descriptor?.set) descriptor.set.call(textarea, text);
      else textarea.value = text;
      if (tracker) tracker.setValue(text);
    }
    try {
      textarea.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    } catch {}
    try {
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text }));
    } catch {
      textarea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    try {
      textarea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    } catch {}
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const classNames = (el) => String(el?.className || '').split(/\s+/);
  const nodeText = (el) => (el?.innerText || el?.textContent || '').replace(/\u00a0/g, ' ');

  const wrapCodeBlock = (block) => {
    const banner = block.querySelector?.('.md-code-block-banner');
    const bannerText = nodeText(banner);
    const lang = bannerText.split('\n').map((line) => line.trim()).find((line) => /^[A-Za-z0-9_+-]+$/.test(line)) || '';
    const codeNode = block.querySelector?.('pre') || block.querySelector?.('code') || block;
    let code = nodeText(codeNode).replace(/\s+$/, '');
    if (bannerText && code.startsWith(bannerText.trim())) code = code.slice(bannerText.trim().length).replace(/^\s+/, '');
    if (!code) return '';
    return '```' + lang + '\n' + code + '\n```';
  };

  const serializeAnswer = (node) => {
    const blocks = node.querySelectorAll ? [...node.querySelectorAll('.md-code-block')] : [];
    const plain = nodeText(node).trim();
    if (!blocks.length) return plain;
    let text = plain;
    for (const block of blocks) {
      const wrapped = wrapCodeBlock(block);
      const raw = nodeText(block).trim();
      if (wrapped && raw && text.includes(raw)) text = text.replace(raw, wrapped);
      else if (wrapped && !text.includes(wrapped)) text += '\n' + wrapped;
    }
    return text.trim();
  };

  const THINK_HOST = '.ds-think-content, [class*="think-content"], [class*="thinking-content"], [class*="think-block"], ._5255ff8, ._4d41763';
  const USER_CLASS = /^(?:_9663006|fbb737a4|d29f3d7d)$/i;
  const ANSWER_CHROME = /^(razonando|pensando|thinking|detenido|stopped|pensado|pensó|已思考|思考中|thought for)\b/i;
  const USERISH = /user-message|message-user|message--user/i;
  const ASSISTANTISH = /assistant-message|message-assistant|message--assistant/i;

  const cleanThinkHeader = (text) => {
    if (!text) return '';
    return String(text).replace(/^(?:(?:razonando|pensando|thinking|detenido|stopped|pensado|pens\u00f3|\u5df2\u601d\u8003|\u601d\u8003\u4e2d|thought for)\b[^\n]*\n*)+/i, '').trim();
  };

  const labeledThink = (node) => {
    let current = node;
    for (let depth = 0; current && depth < 8; depth++) {
      const names = classNames(current);
      if (names.includes('ds-message') || names.some((name) => ASSISTANTISH.test(name))) break;
      const first = nodeText(current).replace(/\s+/g, ' ').trim();
      if (ANSWER_CHROME.test(first) && current.querySelector?.('.ds-markdown, .ds-loading, .ds-cursor')) {
        const thinkChildEl = current.querySelector?.(THINK_HOST);
        if (thinkChildEl && !thinkChildEl.contains(node)) return null;
        return current;
      }
      current = current.parentElement || current.parent || null;
    }
    return null;
  };

  const thinkNode = (node) => {
    if (!node || !node.closest) return null;
    return node.closest(THINK_HOST) || labeledThink(node);
  };

  const thinkChild = (node) =>
    node.querySelector?.(THINK_HOST) || labeledThink(node?.querySelector?.('.ds-markdown') || node);

  const inSidebar = (node) => Boolean(node && node.closest && node.closest(
    'aside, nav, [class*="sidebar" i], [class*="SideBar"], [class*="sider" i], [class*="history-list"], [class*="conversation-list"]'
  ));

  const hasChatPaint = (el) => Boolean(el && el.querySelector && el.querySelector(
    '.ds-markdown, .ds-think-content, .ds-assistant-message-main-content, .ds-message, [class*="think-content"], .ds-cursor'
  ));

  const isHistoryList = (el) => {
    if (!el || inSidebar(el)) return true;
    if ([...(el.querySelectorAll?.('a') || [])].some((anchor) =>
      /\/(?:a\/)?chat\/s\//.test(String(anchor.getAttribute?.('href') || ''))
    )) return true;
    if (hasChatPaint(el)) return false;
    const kids = [...(el.children || [])];
    return kids.length >= 2 && kids.every((child) => nodeText(child).replace(/\s+/g, ' ').trim().length < 80);
  };

  const chatThreadRoot = () => {
    const roots = [...document.querySelectorAll('.ds-virtual-list-visible-items')];
    const threadLike = roots.filter((el) => !isHistoryList(el));
    const withChat = threadLike.filter(hasChatPaint);
    if (withChat.length) return withChat[withChat.length - 1];
    return threadLike[threadLike.length - 1] || null;
  };

  const isUserTurn = (node) => {
    if (!node) return false;
    if (node.closest?.('[data-role="user"], .ds-message--user, .chat-message-user')) return true;
    if (node.closest?.('[data-role="assistant"], .ds-message--assistant, .chat-message-assistant, .ds-assistant-message-main-content')) return false;
    let current = node;
    while (current) {
      const names = classNames(current);
      if (names.some((name) => USER_CLASS.test(name) || USERISH.test(name))) return true;
      if (names.some((name) => ASSISTANTISH.test(name))) return false;
      current = current.parentElement || current.parent || null;
    }
    const looksUserClass = (el) => classNames(el).some((name) => USER_CLASS.test(name) || USERISH.test(name));
    if (looksUserClass(node)) return true;
    for (const child of [...(node.children || [])]) {
      if (looksUserClass(child)) return true;
      for (const inner of [...(child.children || [])]) {
        if (looksUserClass(inner)) return true;
      }
    }
    const message = classNames(node).includes('ds-message') ? node : node.closest?.('.ds-message');
    if (!message) return false;
    if (message.querySelector?.('.ds-assistant-message-main-content, .ds-think-content, [class*="think-content"], ._5255ff8, ._4d41763')) return false;
    if (message.getAttribute?.('data-role') === 'assistant' || classNames(message).some(c => /assistant/i.test(c))) return false;
    return classNames(message).includes('ds-message');
  };

  const serializePublic = (node) => {
    if (!node) return '';
    const markdowns = node.querySelectorAll ? [...node.querySelectorAll('.ds-markdown')] : [];
    const parts = [];
    for (const markdown of markdowns) {
      if (thinkNode(markdown)) continue;
      const text = cleanThinkHeader(serializeAnswer(markdown));
      if (text && !parts.includes(text)) parts.push(text);
    }
    if (parts.length) return parts.join('\n').trim();
    const full = serializeAnswer(node);
    const think = thinkChild(node);
    const thinkText = think ? nodeText(think).trim() : '';
    let remaining = full;
    if (thinkText && full.includes(thinkText)) {
      remaining = full.replace(thinkText, '').replace(/\s+/g, ' ').trim();
    }
    const cleaned = cleanThinkHeader(remaining);
    if (!cleaned || (ANSWER_CHROME.test(cleaned) && cleaned.length < 48)) return '';
    return cleaned;
  };

  const pickAnswerNode = (nodes, options) => {
    const allowThink = options && options.think === true;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (!node) continue;
      // Do not require getClientRects: DeepSeek virtualizes the thread and offscreen
      // rows have empty rects. develop lastAnswer still found those nodes.
      if (node.hidden) continue;
      if (inSidebar(node)) continue;
      if (isUserTurn(node)) continue;
      if (!allowThink && thinkNode(node)) continue;
      if (!allowThink && thinkChild(node)) {
        const pub = node.querySelector?.('.ds-assistant-message-main-content');
        if (pub && cleanThinkHeader(serializeAnswer(pub))) return pub;
        const main = serializePublic(node);
        if (main) return node;
        continue;
      }
      if (node.closest('._9663006, [data-role="user"], .ds-message--user, .chat-message-user, [class*="user-message"], [class*="message-user"]')) continue;
      if (node.closest('textarea, #chat-input')) continue;
      if (classNames(node).includes('md-code-block-banner')) continue;
      const text = cleanThinkHeader(serializeAnswer(node));
      if (text && ANSWER_CHROME.test(text.replace(/\s+/g, ' ').trim()) && text.replace(/\s+/g, ' ').trim().length < 48 && !/```/.test(text)) continue;
      if (text && !options?.allowError && SERVER_ERROR.test(text) && !/```/.test(text) && text.length < 400) continue;
      if (text) return node;
    }
    return null;
  };

  const pickAnswer = (nodes, options) => {
    const node = pickAnswerNode(nodes, options);
    if (!node) return '';
    if (thinkChild(node) && !options?.think) {
      const pub = node.querySelector?.('.ds-assistant-message-main-content');
      if (pub) return cleanThinkHeader(serializeAnswer(pub));
      return serializePublic(node);
    }
    return cleanThinkHeader(serializeAnswer(node));
  };

  const ACK = /^(NEURAFLOK_READY|NEURAL_JAM_READY)$/;
  const titleAck = () => {
    const header = nodeText(document.querySelector('.the-header')).replace(/\s+/g, ' ').trim();
    if (ACK.test(header)) return header;
    const title = String(document.title || '').replace(/\s*[-–—]\s*DeepSeek.*$/i, '').trim();
    return ACK.test(title) ? title : '';
  };

  const assistantAnswerNodes = () => [
    ...document.querySelectorAll('.ds-assistant-message-main-content .ds-markdown, .ds-assistant-message-main-content'),
    ...document.querySelectorAll('.ds-message--assistant .ds-markdown, .ds-message--assistant'),
    ...document.querySelectorAll('[data-role="assistant"] .ds-markdown, [data-role="assistant"]'),
    ...document.querySelectorAll('.chat-message-assistant .ds-markdown, .chat-message-assistant'),
    ...document.querySelectorAll('[class*="assistant-message"] .ds-markdown, [class*="assistant-message"]')
  ];

  const answerMessageRoot = (node) => node?.closest?.('[data-virtual-list-item-key], [data-message-id]') ||
    node?.closest?.('.ds-message--assistant, [data-role="assistant"], .chat-message-assistant, .ds-assistant-message-main-content') ||
    node || null;
  const answerNodeIds = new WeakMap();
  const answerIdentityEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let nextAnswerNodeId = 0;

  const lastAnswerNode = () => safe(() => {
    const assistant = pickAnswerNode([
      ...assistantAnswerNodes(),
      ...document.querySelectorAll('div[class*="assistant"] div[class*="markdown"], div[class*="assistant"] div[class*="content"]')
    ]);
    if (assistant) return assistant;
    const message = pickAnswerNode([...document.querySelectorAll('.ds-message .ds-markdown, .ds-message')]);
    if (message) return message;
    return pickAnswerNode([
      ...document.querySelectorAll('.ds-virtual-list-visible-items .ds-markdown, .ds-virtual-list-visible-items .ds-message'),
      ...document.querySelectorAll('[data-virtual-list-item-key] .ds-markdown, .ds-markdown')
    ]);
  }, null);

  const lastAnswerIdentity = () => safe(() => {
    const answerNode = lastAnswerNode();
    if (!answerNode) {
      const ack = titleAck();
      return ack ? `ack:${ack}` : '';
    }
    const root = answerMessageRoot(answerNode);
    const stableId = root?.getAttribute?.('data-message-id') ||
      root?.getAttribute?.('data-virtual-list-item-key');
    if (stableId) return `message:${stableId}`;

    let identity = answerNodeIds.get(root);
    if (!identity) {
      identity = `node:${answerIdentityEpoch}:${++nextAnswerNodeId}`;
      answerNodeIds.set(root, identity);
    }
    return identity;
  }, '');

  const lastAnswer = () => safe(() => {
    // Same query order as develop, which did paint replies. Recaps/trees are
    // filtered later by publicAnswer leftoverRecap, not by hiding nodes here.
    const node = lastAnswerNode();
    let answer = '';
    if (node) {
      if (thinkChild(node)) {
        const pub = node.querySelector?.('.ds-assistant-message-main-content');
        answer = pub ? cleanThinkHeader(serializeAnswer(pub)) : serializePublic(node);
      } else {
        answer = cleanThinkHeader(serializeAnswer(node));
      }
    } else {
      answer = titleAck();
    }
    const think = lastThink();
    const fold = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    if (answer && think && fold(answer) === fold(think)) return '';
    return answer;
  }, '');

  const lastThink = () => safe(() => pickAnswer(
    [
      ...document.querySelectorAll('.ds-think-content .ds-markdown, .ds-think-content'),
      ...document.querySelectorAll('[class*="think-content"] .ds-markdown, [class*="thinking-content"] .ds-markdown, [class*="think-content"], [class*="thinking-content"]'),
      ...document.querySelectorAll('._5255ff8 .ds-markdown, ._4d41763 .ds-markdown, ._5255ff8, ._4d41763')
    ],
    { think: true }
  ), '');

  const scrollThread = () => {
    try {
      const nodes = [...document.querySelectorAll('.ds-message, .ds-assistant-message-main-content, .ds-markdown')];
      const last = nodes[nodes.length - 1];
      last?.scrollIntoView?.({ block: 'end', inline: 'nearest' });
    } catch {}
    try {
      const root = chatThreadRoot();
      const scroller = root && (root.closest?.('[class*="scroll"]') || root.parentElement || root.parent);
      if (scroller && typeof scroller.scrollTop === 'number') scroller.scrollTop = scroller.scrollHeight || 1e9;
    } catch {}
  };

  const hasConversation = () => safe(() => {
    const threadRoot = chatThreadRoot();
    const scope = threadRoot || document;
    return [...scope.querySelectorAll('.ds-message, .ds-assistant-message-main-content, ._9663006, [data-role="assistant"], [data-role="user"]')]
      .some(node => visible(node) && Boolean(nodeText(node).trim()) && !inSidebar(node));
  }, false);

  let newChatActivated = false;
  let newChatFromPath = '';
  let newChatFromHadConversation = false;
  const currentPath = () => safe(() => {
    const url = new URL(location.href);
    return url.pathname === '' ? '/' : url.pathname;
  }, '');
  const markNewChatActivation = () => {
    newChatActivated = true;
    newChatFromPath = currentPath();
    newChatFromHadConversation = hasConversation();
  };
  const isNewChatRoute = () => safe(() => {
    const url = new URL(location.href);
    if (url.hostname !== 'chat.deepseek.com') return false;
    if (NEW_CHAT_PATH.test(url.pathname)) return true;
    if (!newChatActivated) return false;
    const path = url.pathname === '' ? '/' : url.pathname;
    if (path === '/') return true;
    // DeepSeek opens a fresh conversation at /a/chat/s/<uuid>. It is a new chat
    // when activation navigated to another thread or cleared the current one.
    if (/\/a\/chat\/s\//i.test(path)) {
      if (!newChatFromPath) return false;
      if (path !== newChatFromPath) return true;
      return newChatFromHadConversation && !hasConversation();
    }
    return false;
  }, false);

  const isFreshConversation = () => safe(() => {
    return !hasConversation() && !String(lastAnswer() || '').replace(/\s+/g, ' ').trim();
  }, false);

  const findSend = (ok) => {
    const listed = typeof ok === 'function' ? [...document.querySelectorAll('button, [role="button"]')].filter(ok) : visibleButtons();
    const byPath = listed.find((button) => {
      const path = pathOf(button);
      return path.startsWith(SEND_PATH) && !path.startsWith(ATTACH_PATH);
    });
    if (byPath) return byPath;
    const primary = listed.find((button) => {
      const names = classListOf(button);
      if (!names.includes('ds-button--primary') || !names.includes('ds-button--circle')) return false;
      const path = pathOf(button);
      return !path.startsWith(STOP_PATH) && !path.startsWith(ATTACH_PATH);
    });
    if (primary) return primary;
    const labeled = listed.find((button) => SEND_LABEL.test(labelOf(button)));
    if (labeled) return labeled;
    const box = composer();
    if (box) {
      const container = box.closest('form') || box.closest('div[class*="input"]') || box.parentElement;
      const candidates = container ? [...container.querySelectorAll('button, [role="button"]')].filter(ok || visible) : [];
      const nonAttach = candidates.find(b => {
        const p = pathOf(b);
        return p && !p.startsWith(ATTACH_PATH) && !p.startsWith(STOP_PATH);
      });
      if (nonAttach) return nonAttach;
    }
    return null;
  };

  const sendButton = () => findSend(visible);
  const sendOnPage = () => findSend(onPage);

  const resumeLabel = (label) => {
    const value = String(label || '').replace(/\s+/g, ' ').trim();
    if (!value || value.length > 48) return false;
    if (SEND_LABEL.test(value) || STOP_LABEL.test(value) || NEW_CHAT_LABEL.test(value) || SIDEBAR_CONTINUE.test(value)) return false;
    if (THINK_STOPPED.test(value) && value.length > 24) return false;
    return CONTINUE_LABEL.test(value) || CONTINUE_EXACT.test(value) || RETRY_LABEL.test(value) || CONTINUE_WORD.test(value);
  };

  const isResumeNode = (node) => {
    if (!node || !visible(node)) return false;
    const path = pathOf(node);
    if (path.startsWith(SEND_PATH) || path.startsWith(STOP_PATH) || path.startsWith(ATTACH_PATH)) return false;
    return resumeLabel(labelOf(node));
  };

  const continueButton = () => {
    const labeled = visibleButtons().find(isResumeNode);
    if (labeled) return labeled;
    const clickable = [...document.querySelectorAll('button, [role="button"], a')].find(isResumeNode);
    if (clickable) return clickable;
    // DeepSeek puts Continuar on the Detenido think header as plain text, not always a button.
    const hosts = [...document.querySelectorAll('.ds-think-content, .ds-message')];
    for (const host of hosts) {
      const found = [...(host.querySelectorAll?.('button, [role="button"], a, span, div') || [])]
        .find((node) => node !== host && isResumeNode(node));
      if (found) return found;
    }
    return null;
  };

  const thinkStopped = () => safe(() => {
    const hosts = [...document.querySelectorAll('.ds-think-content, [class*="think-content"]')];
    const host = hosts[hosts.length - 1];
    const roots = host
      ? [host, host.parentElement || host.parent].filter(Boolean)
      : [...document.querySelectorAll('.ds-message')].slice(-1);
    return roots.some((node) => THINK_STOPPED.test(nodeText(node).replace(/\s+/g, ' ').trim()));
  }, false);

  const pageError = () => safe(() => {
    const toasts = [...document.querySelectorAll('[role="alert"], .ds-toast, .ds-message-error')];
    if (toasts.some((node) => {
      if (!visible(node)) return false;
      const text = nodeText(node).replace(/\s+/g, ' ').trim();
      return text.length > 0 && text.length < 400 && SERVER_ERROR.test(text);
    })) return true;
    const latest = pickAnswer(assistantAnswerNodes(), { allowError: true });
    return Boolean(latest) && latest.length < 400 && SERVER_ERROR.test(latest) && !/```/.test(latest);
  }, false);

  const stopButton = () => {
    const box = composer();
    const container = box ? (box.closest('form') || box.closest('div[class*="input"]') || box.parentElement?.parentElement) : null;
    if (container) {
      const candidates = [...container.querySelectorAll('button, [role="button"]')].filter(visible);
      const match = candidates.find(b => {
        const p = pathOf(b);
        return p && p.startsWith(STOP_PATH) && !p.startsWith(ATTACH_PATH);
      }) || candidates.find(b => STOP_LABEL.test(labelOf(b))) || candidates.find(b => b.querySelector('svg rect, svg path[d*="Z"]') && STOP_LABEL.test(labelOf(b)));
      if (match) return match;
    }
    const direct = buttonFor(STOP_PATH) || labeledButton(STOP_LABEL);
    if (direct) return direct;
    const withRect = visibleButtons().find(b => b.querySelector('svg rect, svg path[d*="Z"]') && STOP_LABEL.test(labelOf(b)));
    if (withRect) return withRect;
    return null;
  };

  const hrefOf = (node) => {
    const anchor = node?.closest?.('a[href]') || (node?.getAttribute?.('href') ? node : null);
    return String(anchor?.getAttribute?.('href') || '');
  };
  // A restored conversation in the sidebar can be titled "Nuevo chat"/"New chat".
  // It must never be mistaken for the control that creates a new chat: clicking it
  // navigates back to the old thread, so the send lands on a page that is about to
  // be replaced and the reply is lost.
  const pointsToOldThread = (node) => {
    const href = hrefOf(node);
    if (!href) return false;
    return safe(() => {
      const url = new URL(href, (typeof location !== 'undefined' && location.href) || 'https://chat.deepseek.com/');
      return url.hostname === 'chat.deepseek.com'
        && /\/a\/chat\/s\//i.test(url.pathname)
        && !NEW_CHAT_PATH.test(url.pathname);
    }, false);
  };
  const inHistoryItem = (node) => Boolean(node?.closest?.(
    '[data-virtual-list-item-key], [class*="history-list"], [data-testid*="history"]'
  ));
  const newChatCandidate = (node) => !pointsToOldThread(node) && !inHistoryItem(node);
  const labelFitsControl = (node) => {
    const text = String(node?.textContent || '').replace(/\s+/g, ' ').trim();
    return text.length <= 80;
  };

  const newChat = () => {
    const nodes = [...document.querySelectorAll('a[href], button, [role="button"], [aria-label], [title], [data-testid], [data-tooltip-content], [data-tooltip], [class*="new"], [id*="new"], [class*="conversation"]')]
      .filter(newChatCandidate);
    const enabled = (node) => Boolean(node)
      && node.getAttribute?.('aria-disabled') !== 'true'
      && node.disabled !== true
      && !node.hasAttribute?.('disabled');
    // DeepSeek's sidebar New-chat control is an anchor to the app root. Prefer
    // that exact navigation target because it is safe even inside the sidebar
    // container that the generic history filter excludes.
    const exactHome = [...document.querySelectorAll('a[href="/"], a[href="https://chat.deepseek.com/"], a[href="https://chat.deepseek.com"]')]
      .find((node) => enabled(node) && visible(node) && labelFitsControl(node) && NEW_CHAT_LABEL.test(labelOf(node)));
    if (exactHome) return exactHome;
    const labeled = nodes.find((node) => visible(node) && labelFitsControl(node) && NEW_CHAT_LABEL.test(labelOf(node)))
      || nodes.find((node) => enabled(node) && labelFitsControl(node) && NEW_CHAT_LABEL.test(labelOf(node)));
    if (labeled) return labeled;
    // DeepSeek currently renders its sidebar control as a clickable text container
    // without button/link semantics. Keep this fallback exact so message text that
    // merely mentions creating a chat cannot be mistaken for the control.
    const textControl = [...document.querySelectorAll('div, span')].reverse().find((node) => {
      if (!newChatCandidate(node)) return false;
      const text = nodeText(node).replace(/\s+/g, ' ').trim();
      return visible(node) && NEW_CHAT_EXACT_TEXT.test(text);
    });
    if (textControl) {
      let current = textControl;
      for (let depth = 0; current && depth < 5; depth++) {
        const reactClick = Object.keys(current).some((key) => {
          if (!key.startsWith('__reactProps')) return false;
          const props = current[key];
          return typeof props?.onClick === 'function'
            || typeof props?.onPointerDown === 'function'
            || typeof props?.onPointerDownCapture === 'function';
        });
        if (typeof current.onclick === 'function' || reactClick) return current;
        current = current.parentElement || current.parent || null;
      }
      return textControl;
    }
    return nodes.find((node) => {
      if (!enabled(node)) return false;
      const href = node.getAttribute?.('href') || '';
      if (!href) return false;
      try {
        const url = new URL(href, (typeof location !== 'undefined' && location.href) || 'https://chat.deepseek.com/');
        if (url.hostname !== 'chat.deepseek.com') return false;
        return NEW_CHAT_PATH.test(url.pathname);
      } catch {
        return false;
      }
    }) || null;
  };

  const activateNewChat = (control) => {
    if (!control) return false;
    if (pointsToOldThread(control)) return false;
    const href = control.getAttribute?.('href') || control.querySelector?.('a')?.getAttribute?.('href') || control.closest?.('a')?.getAttribute?.('href') || '';
    const isAnchorHome = Boolean(href && safe(() => {
      const u = new URL(href, (typeof location !== 'undefined' && location.href) || 'https://chat.deepseek.com/');
      return u.hostname === 'chat.deepseek.com' && (u.pathname === '/' || u.pathname === '');
    }, false));
    const isRealButton = control.tagName === 'BUTTON' || control.getAttribute?.('role') === 'button';
    const isRealBrowser = typeof navigator !== 'undefined' && typeof document !== 'undefined' && typeof document.nodeType === 'number';
    if (isAnchorHome || isRealButton || (isRealBrowser && control.nodeType === 1)) {
      markNewChatActivation();
    }
    const handlers = [];
    let current = control;
    for (let depth = 0; current && depth < 6; depth++) {
      for (const key of Object.keys(current)) {
        if (!key.startsWith('__reactProps')) continue;
        const props = current[key];
        if (props && typeof props === 'object') handlers.push(props);
      }
      current = current.parentElement || current.parent || null;
    }
    const hasReactClick = handlers.some(props => typeof props.onClick === 'function');
    const hasReactPointerDown = handlers.some(props =>
      typeof props.onPointerDown === 'function' || typeof props.onPointerDownCapture === 'function'
    );
    if (hasReactPointerDown && !hasReactClick && typeof control.dispatchEvent === 'function') {
      const PointerEventCtor = safe(() => globalThis.PointerEvent || window.PointerEvent, null);
      if (typeof PointerEventCtor !== 'function') return false;
      control.dispatchEvent(new PointerEventCtor('pointerdown', {
        bubbles: true, cancelable: true, composed: true,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1
      }));
      control.dispatchEvent(new PointerEventCtor('pointerup', {
        bubbles: true, cancelable: true, composed: true,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0
      }));
      return true;
    }
    if (typeof control.click !== 'function') return false;
    control.click();
    return true;
  };

  const newChatVisible = () => {
    const control = newChat();
    return Boolean(control && visible(control));
  };

  // Proves the provider accepted the prompt: the sent text is rendered as a
  // user message. The composer is skipped because it still holds the draft.
  const sentVisible = (text) => safe(() => {
    const probe = String(text || '').replace(/\s+/g, ' ').trim();
    if (!probe) return false;
    const tail = probe.slice(-80);
    const hosts = [...document.querySelectorAll(
      '.ds-message, ._9663006, [data-role="user"], [class*="user-message"], [class*="message-user"]'
    )];
    return hosts.some((node) => !inSidebar(node) && !node.closest?.('textarea, #chat-input')
      && isUserTurn(node) && nodeText(node).replace(/\s+/g, ' ').includes(tail));
  }, false);

  const generating = () => {    // Stop means DeepSeek is streaming. Send still on the page (even disabled while the
    // composer is empty) means the turn is idle. A leftover cursor or think spinner after a
    // finished reply must not keep NEURAFLOK on Thinking.
    // Live Stop with no Send is a new stream even if leftover Continuar sits on an old recap.
    // Detenido / server-unavailable means the stream already paused: click resume, even if a
    // leftover Stop icon is still in the composer.
    const send = sendButton();
    const sendShown = send || sendOnPage();
    const stop = stopButton();
    const paused = pageError() || thinkStopped();
    if (stop && !send && !paused) return true;
    if (continueButton() || paused) return false;
    const box = composer();
    const composerHeld = Boolean(box && (box.disabled || box.readOnly));
    if (stop && !send) return true;
    if (sendShown) return false;
    if (composerHeld) return true;
    const hosts = [...document.querySelectorAll('.ds-assistant-message-main-content, .ds-message--assistant, [class*="assistant-message"], .ds-message')]
      .filter((el) => !inSidebar(el) && !isUserTurn(el));
    const lastHost = hosts[hosts.length - 1];
    if (lastHost?.querySelector?.('.ds-cursor')) return true;
    const ans = lastAnswer();
    if (!ans && lastHost?.querySelector?.('.ds-loading')) return true;
    return false;
  };

  const pathKindOf = (pathname) => {
    if (NEW_CHAT_PATH.test(pathname)) return 'new-chat';
    if (/\/a\/chat\/s\//i.test(pathname)) return 'thread';
    if (pathname === '/' || pathname === '') return 'home';
    return 'other';
  };

  const pathKind = () => safe(() => {
    const url = new URL(location.href);
    if (url.hostname !== 'chat.deepseek.com') return 'other';
    return pathKindOf(url.pathname);
  }, 'other');

  const newChatFromKind = () => newChatFromPath ? pathKindOf(newChatFromPath) : 'none';

  const newChatKind = () => safe(() => {
    const control = newChat();
    if (!control) return 'none';
    const href = hrefOf(control);
    if (href) {
      const url = new URL(href, (typeof location !== 'undefined' && location.href) || 'https://chat.deepseek.com/');
      if (url.hostname !== 'chat.deepseek.com') return 'anchor-other';
      if (url.pathname === '/' || url.pathname === '') return 'anchor-home';
      if (NEW_CHAT_PATH.test(url.pathname)) return 'anchor-path';
      return 'anchor-other';
    }
    if (control.tagName === 'BUTTON' || control.getAttribute?.('role') === 'button') return 'button';
    return 'text';
  }, 'none');

  const inspect = () => safe(() => {
    return {
      answerLength: lastAnswer().length,
      thinkLength: lastThink().length,
      md: document.querySelectorAll('.ds-markdown').length,
      msgs: document.querySelectorAll('.ds-message').length,
      gen: generating(),
      send: Boolean(sendButton() || sendOnPage()),
      stop: Boolean(stopButton()),
      hasConversation: hasConversation(),
      freshConversation: isFreshConversation(),
      newChatRoute: isNewChatRoute(),
      newChatActivated,
      newChatFromKind: newChatFromKind(),
      newChatKind: newChatKind(),
      pathKind: pathKind(),
      newChatAvailable: Boolean(newChat())
    };
  }, null);

  return {
    composer,
    sendButton,
    stopButton,
    generating,
    sentVisible,
    lastAnswer,
    lastAnswerIdentity,
    lastThink,
    scrollThread,
    inspect,
    thinkStopped,
    continueButton,
    pageError,
    hasConversation,
    isNewChatRoute,
    isFreshConversation,
    newChatVisible,
    activateNewChat,
    setValue,
    signedIn: () => !!composer() || !!document.querySelector('.ds-avatar, [class*="avatar"], button[class*="user"], .user-profile, div[class*="avatar"], img[class*="avatar"]'),
    newChat
  };
})();
