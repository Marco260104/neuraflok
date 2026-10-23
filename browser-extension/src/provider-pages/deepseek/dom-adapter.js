// Detect DeepSeek composer, conversation, answer, and send controls.
var NEURAFLOK_DEEPSEEK = (() => {
  const SEND_PATH = 'M8.3125 0.98';
  const STOP_PATH = 'M2 4.88';
  const ATTACH_PATH = 'M5.5498';
  const SEND_LABEL = /^(send|enviar|envoyer|senden|送信|发送|傳送|보내기)$/i;
  const STOP_LABEL = /^(stop|cancel|detener|parar|停止|중지|arrêt|остановить)$/i;
  const CONTINUE_LABEL = /^(continue(?:\s+(?:generating|response|answer))?|keep going|continuar(?:\s+(?:generando|respuesta))?|seguir(?:\s+generando)?|continuer(?:\s+la génération)?|fortsetzen|weiter(?:\s+generieren)?|weitermachen|続行|続ける|生成を続ける|계속(?:\s*생성)?|继续(?:生成|回答)?|繼續(?:生成|回答)?|продолжить(?:\s+генерацию)?|devam(?:\s+et)?|tiếp tục)$/i;
  const NEW_CHAT_LABEL = /new chat|nuevo chat|nouvelle conversation|neuer chat|新しいチャット|新对话|新對話|새 채팅/i;

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
  const labelOf = (node) => `${node?.getAttribute?.('aria-label') || ''} ${node?.textContent || ''}`.replace(/\s+/g, ' ').trim();

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

  const continueButton = () => visibleButtons().find((button) => {
    const labels = [button.getAttribute?.('aria-label'), button.textContent]
      .filter(Boolean).map(value => String(value).replace(/\s+/g, ' ').trim());
    return labels.some(label => CONTINUE_LABEL.test(label));
  }) || null;

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

  const thinkNode = (node) =>
    node.closest('.ds-think-content') ||
    node.closest('[class*="think-content"]') ||
    node.closest('[class*="thinking-content"]');

  const thinkChild = (node) =>
    node.querySelector?.('.ds-think-content, [class*="think-content"], [class*="thinking-content"]');

  const pickAnswer = (nodes, options) => {
    const allowThink = options && options.think === true;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (!allowThink && thinkNode(node)) continue;
      if (!allowThink && thinkChild(node)) {
        const pub = node.querySelector?.('.ds-assistant-message-main-content');
        if (!pub) continue;
        const nested = serializeAnswer(pub);
        if (nested) return nested;
        continue;
      }
      if (node.closest('._9663006, [data-role="user"], .ds-message--user, .chat-message-user, [class*="user-message"], [class*="message-user"]')) continue;
      if (node.closest('textarea, #chat-input')) continue;
      if (classNames(node).includes('md-code-block-banner')) continue;
      const text = serializeAnswer(node);
      if (text) return text;
    }
    return '';
  };

  const ACK = /^(NEURAFLOK_READY|NEURAL_JAM_READY)$/;
  const titleAck = () => {
    const header = nodeText(document.querySelector('.the-header')).replace(/\s+/g, ' ').trim();
    if (ACK.test(header)) return header;
    const title = String(document.title || '').replace(/\s*[-–—]\s*DeepSeek.*$/i, '').trim();
    return ACK.test(title) ? title : '';
  };

  const lastAnswer = () => safe(() => {
    const assistant = pickAnswer([
      ...document.querySelectorAll('.ds-assistant-message-main-content .ds-markdown, .ds-assistant-message-main-content'),
      ...document.querySelectorAll('.ds-message--assistant .ds-markdown, .ds-message--assistant'),
      ...document.querySelectorAll('[data-role="assistant"] .ds-markdown, [data-role="assistant"]'),
      ...document.querySelectorAll('.chat-message-assistant .ds-markdown, .chat-message-assistant'),
      ...document.querySelectorAll('[class*="assistant-message"] .ds-markdown, [class*="assistant-message"]'),
      ...document.querySelectorAll('div[class*="assistant"] div[class*="markdown"], div[class*="assistant"] div[class*="content"]')
    ]);
    if (assistant) return assistant;
    const message = pickAnswer([...document.querySelectorAll('.ds-message .ds-markdown, .ds-message')]);
    if (message) return message;
    const listed = pickAnswer([
      ...document.querySelectorAll('.ds-virtual-list-visible-items .ds-markdown, .ds-virtual-list-visible-items .ds-message'),
      ...document.querySelectorAll('[data-virtual-list-item-key] .ds-markdown, .ds-markdown')
    ]);
    if (listed) return listed;
    return titleAck();
  }, '');

  const lastThink = () => safe(() => pickAnswer(
    [
      ...document.querySelectorAll('.ds-think-content .ds-markdown, .ds-think-content'),
      ...document.querySelectorAll('[class*="think-content"], [class*="thinking-content"]')
    ],
    { think: true }
  ), '');

  const hasConversation = () => safe(() =>
    [...document.querySelectorAll('.ds-message, .ds-assistant-message-main-content, ._9663006, [data-role="assistant"], [data-role="user"]')]
      .some(node => visible(node) && Boolean(nodeText(node).trim())), false);

  const sendButton = () => {
    const direct = buttonFor(SEND_PATH) || primaryCircle() || labeledButton(SEND_LABEL);
    if (direct) return direct;
    const box = composer();
    if (box) {
      const container = box.closest('form') || box.closest('div[class*="input"]') || box.parentElement;
      const candidates = container ? [...container.querySelectorAll('button, [role="button"]')].filter(visible) : [];
      const nonAttach = candidates.find(b => {
        const p = pathOf(b);
        return p && !p.startsWith(ATTACH_PATH) && !p.startsWith(STOP_PATH);
      });
      if (nonAttach) return nonAttach;
    }
    return null;
  };

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

  const newChat = () => {
    const nodes = [...document.querySelectorAll('a[href], button, [role="button"]')];
    return nodes.find((node) => {
      if (!visible(node)) return false;
      const href = node.getAttribute?.('href') || '';
      if (href) {
        try {
          const url = new URL(href, (typeof location !== 'undefined' && location.href) || 'https://chat.deepseek.com/');
          if (url.hostname === 'chat.deepseek.com' && (url.pathname === '/' || url.pathname === '')) return true;
        } catch {}
      }
      return NEW_CHAT_LABEL.test(labelOf(node));
    }) || null;
  };

  return {
    composer,
    sendButton,
    stopButton,
    continueButton,
    generating: () => {
      // Streaming cursor/spinner is the live signal. A leftover Send icon on the page must not
      // end the turn while DeepSeek is still thinking or writing a tool call.
      if (document.querySelector('.ds-assistant-message-main-content .ds-loading, .ds-message--assistant .ds-loading, [class*="assistant-message"] .ds-loading, .ds-cursor, .ds-think-content .ds-loading')) return true;
      const box = composer();
      if (box && (box.disabled || box.readOnly)) return true;
      const send = sendButton();
      const stop = stopButton();
      // An enabled Send button proves generation is not active, even if a decoy/leftover Stop icon exists
      if (send) return false;
      if (stop) return true;
      return false;
    },
    lastAnswer,
    lastThink,
    hasConversation,
    setValue,
    signedIn: () => !!composer() || !!document.querySelector('.ds-avatar, [class*="avatar"], button[class*="user"], .user-profile'),
    newChat
  };
})();
