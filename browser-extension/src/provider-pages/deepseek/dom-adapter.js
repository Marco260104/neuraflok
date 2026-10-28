// Detect DeepSeek composer, conversation, answer, and send controls.
var NEURAFLOK_DEEPSEEK = (() => {
  const SEND_PATH = 'M8.3125 0.98';
  const STOP_PATH = 'M2 4.88';
  const ATTACH_PATH = 'M5.5498';
  const SEND_LABEL = /^(send|enviar|envoyer|senden|送信|发送|傳送|보내기)$/i;
  const STOP_LABEL = /^(stop|cancel|detener|parar|停止|중지|arrêt|остановить)$/i;
  const CONTINUE_LABEL = /^(continue(?:\s+(?:generating|response|answer))?|keep going|continuar(?:\s+(?:generando|respuesta))?|seguir(?:\s+generando)?|continuer(?:\s+la génération)?|fortsetzen|weiter(?:\s+generieren)?|weitermachen|続行|続ける|生成を続ける|계속(?:\s*생성)?|继续(?:生成|回答)?|繼續(?:生成|回答)?|продолжить(?:\s+генерацию)?|devam(?:\s+et)?|tiếp tục)$/i;
  const NEW_CHAT_LABEL = /new[-_\s]+(?:chat|conversation|thread)|(?:start|create)\s+(?:a\s+)?new\s+(?:chat|conversation|thread)|nuevo\s+chat|nueva\s+conversación|nouvelle\s+conversation|neuer\s+chat|新しいチャット|新对话|新對話|새\s*채팅/i;
  const EXACT_NEW_CHAT_LABEL = /^(?:new[-_\s]+(?:chat|conversation|thread)|(?:start|create)\s+(?:a\s+)?new\s+(?:chat|conversation|thread)|nuevo\s+chat|nueva\s+conversación|nouvelle\s+conversation|neuer\s+chat|新しいチャット|新对话|新對話|새\s*채팅)(?:\s+(?:ctrl|control)\s*\+\s*[a-z0-9]+)?$/i;

  const safe = (fn, fallback) => {
    try {
      const value = fn();
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  };
  const EDITABLE_SELECTOR = 'textarea, input, [contenteditable], [role="textbox"]';
  const editableNodes = () => {
    const topLevel = safe(() => [...document.querySelectorAll(EDITABLE_SELECTOR)], []);
    const roots = [document];
    const visited = new Set();
    const found = [];
    let inspected = 0;
    while (roots.length && visited.size < 32 && inspected < 5_000) {
      const root = roots.shift();
      if (!root || visited.has(root)) continue;
      visited.add(root);
      found.push(...(root === document ? topLevel : safe(() => [...root.querySelectorAll(EDITABLE_SELECTOR)], [])));
      const hosts = safe(() => [...root.querySelectorAll('*')], []);
      for (const host of hosts) {
        inspected += 1;
        if (host?.shadowRoot && !visited.has(host.shadowRoot)) roots.push(host.shadowRoot);
        if (inspected >= 5_000) break;
      }
    }
    return [...new Set(found)];
  };

  const openShadowRoots = () => {
    const roots = [document];
    const visited = new Set();
    let inspected = 0;
    for (let index = 0; index < roots.length && index < 32 && inspected < 5_000; index += 1) {
      const root = roots[index];
      if (!root || visited.has(root)) continue;
      visited.add(root);
      for (const host of safe(() => [...root.querySelectorAll('*')], [])) {
        inspected += 1;
        if (host?.shadowRoot && !visited.has(host.shadowRoot)) roots.push(host.shadowRoot);
        if (inspected >= 5_000) break;
      }
    }
    return roots;
  };

  const queryOpenRoots = (roots, selector) => roots.flatMap(root =>
    safe(() => [...root.querySelectorAll(selector)], [])
  );

  const pathOf = (button) => button?.querySelector?.('svg path')?.getAttribute?.('d') || '';
  const visible = (node, allowBackgroundLayout = false) => {
    if (!node) return false;
    if (node.getAttribute?.('aria-disabled') === 'true' || node.disabled === true || node.hasAttribute?.('disabled')) return false;
    const classList = node.classList ? [...node.classList] : [];
    if (classList.some((c) => /disabled/i.test(c))) return false;
    let current = node;
    while (current) {
      if (current.hidden === true || current.getAttribute?.('hidden') !== null && current.getAttribute?.('hidden') !== undefined ||
          current.getAttribute?.('aria-hidden') === 'true') return false;
      const style = safe(() => typeof getComputedStyle === 'function' ? getComputedStyle(current) : current.style, null);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
          Number.parseFloat(style.opacity) === 0)) return false;
      current = current.parentElement || current.parent || safe(() => current.getRootNode?.().host, null) || null;
    }
    const rects = typeof node.getClientRects === 'function' ? node.getClientRects() : [];
    if (rects.length > 0) return true;
    // Background WebContentsViews can have no client rects even though their
    // page controls are mounted and can still be driven programmatically. In
    // Electron a minimized parent window does not consistently update the
    // child document's visibilityState, so trust the caller's background
    // control lookup after rejecting CSS-hidden and disabled nodes above.
    return allowBackgroundLayout;
  };
  const labelOf = (node) => `${node?.getAttribute?.('aria-label') || ''} ${node?.getAttribute?.('title') || ''} ${node?.getAttribute?.('data-testid') || ''} ${node?.textContent || ''}`.replace(/\s+/g, ' ').trim();

  const visibleButtons = () => [...document.querySelectorAll('button, [role="button"]')].filter(node => visible(node, true));

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

  const continueButton = () => {
    const accessible = visibleButtons().find((button) => {
      const labels = [button.getAttribute?.('aria-label'), button.textContent]
        .filter(Boolean).map(value => String(value).replace(/\s+/g, ' ').trim());
      return labels.some(label => CONTINUE_LABEL.test(label));
    });
    if (accessible) return accessible;

    // DeepSeek also renders Continue as a ds-button container whose visible
    // label lives in a nested `.ds-button__content` span. These controls do not
    // always expose a native button or role=button, so resolve the clickable
    // wrapper directly and fall back to the content node for event bubbling.
    const content = [...document.querySelectorAll('.ds-button__content')].find((node) =>
      visible(node, true) && CONTINUE_LABEL.test(String(node.textContent || '').replace(/\s+/g, ' ').trim())
    );
    if (!content) return null;
    const control = content.closest?.('button, [role="button"], .ds-button');
    return control && visible(control, true) ? control : content;
  };

  const isComposerContainer = (node) => Boolean(node?.closest?.('.ds-input, [class*="chat-input"], [class*="composer"]'));
  const looksLikeSearchField = (node) => {
    const name = node?.getAttribute?.('name') || '';
    const id = node?.getAttribute?.('id') || '';
    const placeholder = node?.getAttribute?.('placeholder') || '';
    const ariaLabel = node?.getAttribute?.('aria-label') || '';
    const title = node?.getAttribute?.('title') || '';
    const testId = node?.getAttribute?.('data-testid') || '';
    const label = [name, id, placeholder, ariaLabel, title, testId].filter(Boolean).join(' ');
    // Current DeepSeek builds put the chat textarea in a scroll-area and mark
    // it `name="search"`. Its visible prompt is the reliable signal that this
    // is the message composer, so the generic search-name heuristic must not
    // discard it.
    const explicitChatInput = id === 'chat-input' ||
      /(?:message|mensaje|mensagem|メッセージ).*deepseek|deepseek.*(?:message|mensaje|mensagem|メッセージ)|ask\s+deepseek/i.test(`${placeholder} ${ariaLabel} ${title} ${testId}`);
    return /search|find|buscar|recherche|suche|搜索|查找/i.test(label) && !explicitChatInput && !isComposerContainer(node);
  };
  const looksLikeSignInField = (node) => {
    const type = String(node?.getAttribute?.('type') || '').toLowerCase();
    const identity = [
      node?.getAttribute?.('name'), node?.getAttribute?.('id'), node?.getAttribute?.('placeholder'),
      node?.getAttribute?.('aria-label'), node?.getAttribute?.('title'), node?.getAttribute?.('data-testid')
    ].filter(Boolean).join(' ');
    return ['email', 'password', 'tel', 'number'].includes(type) ||
      /e-?mail|password|username|phone|telephone|verification|one[- ]?time|log.?in|sign.?in/i.test(identity);
  };

  const composer = () => {
    const candidates = editableNodes()
      .filter(node => visible(node, true) && node.disabled !== true && node.readOnly !== true &&
        node.getAttribute?.('contenteditable') !== 'false' && !looksLikeSearchField(node) && !looksLikeSignInField(node));
    const bySelector = (selector) => candidates.find(node => safe(() => node.matches?.(selector), false)) || null;
    return bySelector('textarea#chat-input, input#chat-input, [contenteditable]#chat-input, [role="textbox"]#chat-input') ||
      bySelector('.ds-input textarea, .ds-input input, .ds-input [contenteditable], .ds-input [role="textbox"]') ||
      bySelector('div[class*="chat-input"] textarea, div[class*="chat-input"] input, div[class*="chat-input"] [contenteditable], div[class*="chat-input"] [role="textbox"]') ||
      candidates.find(isComposerContainer) ||
      candidates.find(node => node.tagName !== 'TEXTAREA' && node.tagName !== 'INPUT') ||
      candidates.find(node => node.tagName === 'TEXTAREA') ||
      candidates.find(node => node.tagName === 'INPUT') || null;
  };

  const authenticatedWorkspace = () => {
    // Electron can report zero-sized client rects while restoring a provider
    // page. DeepSeek also changes the composer markup between releases, so do
    // not require the old #chat-input id to recognize an authenticated
    // workspace. A unique chat control is enough for presence; execution still
    // requires a usable composer before it can send anything.
    if (workspaceNavigationPresent()) return true;
    const input = editableNodes()
      .find(node => {
        if (node.disabled === true || node.readOnly === true ||
            node.getAttribute?.('aria-disabled') === 'true' ||
            node.getAttribute?.('contenteditable') === 'false' ||
            node.getAttribute?.('aria-hidden') === 'true' || node.hidden === true ||
            looksLikeSearchField(node) || looksLikeSignInField(node)) return false;
        const type = String(node.getAttribute?.('type') || '').toLowerCase();
        if (type === 'email' || type === 'password') return false;
        const identity = [
          node.getAttribute?.('id'), node.getAttribute?.('class'), node.getAttribute?.('name'),
          node.getAttribute?.('placeholder'), node.getAttribute?.('aria-label'),
          node.getAttribute?.('data-testid')
        ].filter(Boolean).join(' ');
        if (/e-?mail|password|username|log.?in|sign.?in/i.test(identity)) return false;
        return isComposerContainer(node) || /chat-input|composer|message|mensaje|ask deepseek/i.test(identity) ||
          node.tagName === 'TEXTAREA' || node.getAttribute?.('contenteditable') !== null ||
          node.getAttribute?.('role') === 'textbox';
      });
    if (!input) return false;
    return !!input;
  };

  const setValue = (textarea, text) => {
    try {
      textarea.focus();
      textarea.select?.();
    } catch {}
    let inserted = false;
    const isTextControl = /^(TEXTAREA|INPUT)$/.test(String(textarea?.tagName || '').toUpperCase());
    try {
      if (!isTextControl) document.execCommand?.('selectAll', false);
      inserted = document.execCommand?.('insertText', false, text) === true;
    } catch {}
    if (!isTextControl) {
      const currentText = String(textarea.innerText || textarea.textContent || '').trim();
      if (!inserted || currentText !== text.trim()) {
        textarea.textContent = text;
        try { textarea.innerText = text; } catch {}
      }
    } else if (!inserted || textarea.value !== text) {
      const proto = Object.getPrototypeOf(textarea);
      const elementPrototype = String(textarea.tagName).toUpperCase() === 'INPUT'
        ? window.HTMLInputElement?.prototype
        : window.HTMLTextAreaElement?.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(elementPrototype || {}, 'value');
      if (descriptor?.set) descriptor.set.call(textarea, text);
      else textarea.value = text;
      // Keep React's value tracker at its previous value. React compares it
      // with the native textarea value during the input event; advancing the
      // tracker here makes React discard the event as if nothing changed.
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

  const codeBlockParts = (block) => {
    const banner = block.querySelector?.('.md-code-block-banner');
    const bannerText = nodeText(banner);
    const lang = bannerText.split('\n').map((line) => line.trim()).find((line) => /^[A-Za-z0-9_+-]+$/.test(line)) || '';
    const codeNode = block.querySelector?.('pre') || block.querySelector?.('code') || block;
    let code = nodeText(codeNode).replace(/\s+$/, '');
    if (bannerText && code.startsWith(bannerText.trim())) code = code.slice(bannerText.trim().length).replace(/^\s+/, '');
    const controls = [bannerText, ...[...(block.querySelectorAll?.('button') || [])].flatMap(button => [
      nodeText(button), button.getAttribute?.('aria-label') || '', button.getAttribute?.('title') || ''
    ])].flatMap(value => String(value).split('\n')).map(value => value.trim()).filter(Boolean);
    return {
      code,
      raw: nodeText(block).trim(),
      controls: new Set(controls),
      wrapped: code ? '```' + lang + '\n' + code + '\n```' : ''
    };
  };

  const trimAdjacentCodeChrome = (value, controls, fromEnd) => {
    const lines = value.split('\n');
    const chrome = (line) => controls.has(line.trim()) || /^(?:svg){1,4}$/i.test(line.trim());
    let removed = false;
    if (fromEnd) {
      let index = lines.length - 1;
      while (index >= 0 && !lines[index].trim()) index--;
      while (index >= 0 && chrome(lines[index])) {
        removed = true;
        index--;
        while (index >= 0 && !lines[index].trim()) index--;
      }
      return removed ? lines.slice(0, index + 1).join('\n') : value;
    }
    let index = 0;
    while (index < lines.length && !lines[index].trim()) index++;
    while (index < lines.length && chrome(lines[index])) {
      removed = true;
      index++;
      while (index < lines.length && !lines[index].trim()) index++;
    }
    return removed ? lines.slice(index).join('\n') : value;
  };

  const serializeAnswer = (node) => {
    const blocks = node.querySelectorAll ? [...node.querySelectorAll('.md-code-block')] : [];
    const plain = nodeText(node).trim();
    if (!blocks.length) return plain;
    let text = plain;
    let searchFrom = 0;
    for (const block of blocks) {
      const parts = codeBlockParts(block);
      if (!parts.wrapped) continue;
      const rawAt = parts.raw ? text.indexOf(parts.raw, searchFrom) : -1;
      if (rawAt >= 0) {
        text = text.slice(0, rawAt) + parts.wrapped + text.slice(rawAt + parts.raw.length);
        searchFrom = rawAt + parts.wrapped.length;
        continue;
      }
      // innerText on an assistant container can normalize code-block spacing
      // differently from the block itself, or omit its Copy/SVG toolbar. Use
      // the actual <pre> text as the anchor and discard adjacent toolbar rows
      // instead of duplicating the unformatted code at the end of the answer.
      const codeAt = text.indexOf(parts.code, searchFrom);
      if (codeAt < 0) {
        if (!text.includes(parts.wrapped)) text += '\n' + parts.wrapped;
        searchFrom = text.length;
        continue;
      }
      const before = trimAdjacentCodeChrome(text.slice(0, codeAt), parts.controls, true).trimEnd();
      const after = trimAdjacentCodeChrome(text.slice(codeAt + parts.code.length), parts.controls, false).trimStart();
      text = `${before}${before ? '\n\n' : ''}${parts.wrapped}${after ? '\n\n' + after : ''}`;
      searchFrom = before.length + (before ? 2 : 0) + parts.wrapped.length;
    }
    return text.trim();
  };

  const thinkNode = (node) =>
    node.closest('.ds-think-content') ||
    node.closest('[class*="think-content"]') ||
    node.closest('[class*="thinking-content"]');

  const thinkChild = (node) =>
    node.querySelector?.('.ds-think-content, [class*="think-content"], [class*="thinking-content"]');

  const pickAnswerNode = (nodes, options) => {
    const allowThink = options && options.think === true;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (!allowThink && thinkNode(node)) continue;
      if (!allowThink && thinkChild(node)) {
        const pub = node.querySelector?.('.ds-assistant-message-main-content');
        if (!pub) continue;
        if (serializeAnswer(pub)) return pub;
        continue;
      }
      if (node.closest('._9663006, [data-role="user"], .ds-message--user, .chat-message-user, [class*="user-message"], [class*="message-user"]')) continue;
      if (node.closest('textarea, #chat-input')) continue;
      if (classNames(node).includes('md-code-block-banner')) continue;
      if (serializeAnswer(node)) return node;
    }
    return null;
  };

  const pickAnswer = (nodes, options) => {
    const node = pickAnswerNode(nodes, options);
    return node ? serializeAnswer(node) : '';
  };

  const ACK = /^(NEURAFLOK_READY|NEURAL_JAM_READY)$/;
  const titleAck = () => {
    const header = nodeText(document.querySelector('.the-header')).replace(/\s+/g, ' ').trim();
    if (ACK.test(header)) return header;
    const title = String(document.title || '').replace(/\s*[-–—]\s*DeepSeek.*$/i, '').trim();
    return ACK.test(title) ? title : '';
  };

  const answerCandidates = () => [
      ...document.querySelectorAll('.ds-assistant-message-main-content .ds-markdown, .ds-assistant-message-main-content'),
      ...document.querySelectorAll('.ds-message--assistant .ds-markdown, .ds-message--assistant'),
      ...document.querySelectorAll('[data-role="assistant"] .ds-markdown, [data-role="assistant"]'),
      ...document.querySelectorAll('.chat-message-assistant .ds-markdown, .chat-message-assistant'),
      ...document.querySelectorAll('[class*="assistant-message"] .ds-markdown, [class*="assistant-message"]'),
      ...document.querySelectorAll('div[class*="assistant"] div[class*="markdown"], div[class*="assistant"] div[class*="content"]')
  ];

  const answerMessageRoot = (node) => node?.closest?.('[data-virtual-list-item-key], [data-message-id]') ||
    node?.closest?.('.ds-message--assistant, [data-role="assistant"], .chat-message-assistant, .ds-assistant-message-main-content') ||
    node || null;
  const answerNodeIds = new WeakMap();
  const answerIdentityEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let nextAnswerNodeId = 0;

  const lastAnswerNode = () => safe(() => {
    const assistant = pickAnswerNode(answerCandidates());
    if (assistant) return assistant;
    const message = pickAnswerNode([...document.querySelectorAll('.ds-message .ds-markdown, .ds-message')]);
    if (message) return message;
    return pickAnswerNode([
      ...document.querySelectorAll('.ds-virtual-list-visible-items .ds-markdown, .ds-virtual-list-visible-items .ds-message'),
      ...document.querySelectorAll('[data-virtual-list-item-key] .ds-markdown, .ds-markdown')
    ]);
  }, null);

  const lastAnswer = () => safe(() => {
    const node = lastAnswerNode();
    return node ? serializeAnswer(node) : titleAck();
  }, '');

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

    // Keep a stable identity for this rendered message even if its text changes
    // while streaming. A changed list index is not enough: virtualization can
    // shift indices and make an old answer look new.
    let identity = answerNodeIds.get(root);
    if (!identity) {
      identity = `node:${answerIdentityEpoch}:${++nextAnswerNodeId}`;
      answerNodeIds.set(root, identity);
    }
    return identity;
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
    const roots = openShadowRoots();
    const nodes = queryOpenRoots(roots, 'a[href], button, [role="button"]');
    // The home/logo link also points at `/` on DeepSeek, but it can reopen the
    // last conversation instead of starting a fresh one. Only trust an
    // explicitly named new-chat control; an unknown control must fail closed.
    const accessible = nodes.find((node) => visible(node, true) && NEW_CHAT_LABEL.test(labelOf(node)));
    if (accessible) return accessible;

    // Some DeepSeek builds render the sidebar action as a custom .ds-button
    // whose label is only exposed by its child span, without a button role.
    // Resolve only that explicit label and click its nearest known wrapper;
    // bubbling from the span remains a safe fallback for custom controls.
    const content = queryOpenRoots(roots, '.ds-button__content').find((node) =>
      visible(node, true) && NEW_CHAT_LABEL.test(String(node.textContent || '').replace(/\s+/g, ' ').trim())
    );
    if (content) {
      const control = content.closest?.('button, [role="button"], .ds-button');
      return control && visible(control, true) ? control : content;
    }

    // Some DeepSeek layouts expose the sidebar action only as a labeled group,
    // with neither a button role nor the usual ds-button content class. Match
    // the exact action text (and optional keyboard shortcut) so conversation
    // text such as "start a new chat" can never become a navigation target.
    const labeled = queryOpenRoots(roots, '*').filter(node => {
      if (!visible(node, true)) return false;
      const label = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      return label.length <= 80 && EXACT_NEW_CHAT_LABEL.test(label);
    }).sort((left, right) =>
      String(left.innerText || left.textContent || '').length - String(right.innerText || right.textContent || '').length
    )[0];
    if (!labeled) return null;
    const control = labeled.closest?.('button, [role="button"], a[href], .ds-button');
    return control && visible(control, true) ? control : labeled;
  };

  const workspaceNavigationPresent = () => {
    // DeepSeek renders the authenticated sidebar's "new chat" row as a group
    // in some builds, not as a button or link. Conversation routes are a more
    // stable signal that the account workspace is present; requiring a
    // discoverable new-chat button incorrectly labels that signed-in page as
    // logged out and prevents the message from ever reaching its composer.
    return safe(() => [...document.querySelectorAll('a[href]')].some(node => {
      const href = String(node.getAttribute?.('href') || node.href || '');
      return /\/a\/chat\//i.test(href) && node.hidden !== true && node.getAttribute?.('aria-hidden') !== 'true';
    }), false);
  };

  const api = {
    composer,
    sendButton,
    stopButton,
    continueButton,
    generating: () => {
      const box = composer();
      if (box && (box.disabled || box.readOnly)) return true;
      const send = sendButton();
      // DeepSeek can show the animated cursor while keeping Send visible. The
      // generic loading nodes are weaker signals and sometimes remain mounted.
      if (document.querySelector('.ds-cursor')) return true;
      // An enabled Send button proves generation is not active, even if a decoy/leftover Stop icon exists
      if (send) return false;
      // Spinners can remain mounted after the reply finishes, so consult the
      // enabled send control first. With no send button, the live stream marker
      // is useful evidence that generation is still active.
      if (document.querySelector('.ds-assistant-message-main-content .ds-loading, .ds-message--assistant .ds-loading, [class*="assistant-message"] .ds-loading, .ds-think-content .ds-loading')) return true;
      const stop = stopButton();
      if (stop) return true;
      return false;
    },
    lastAnswer,
    lastAnswerIdentity,
    lastThink,
    hasConversation,
    setValue,
    signedIn: () => !!composer() || authenticatedWorkspace() || workspaceNavigationPresent() || !!document.querySelector('.ds-avatar, [class*="avatar"], button[class*="user"], .user-profile'),
    newChat,
  };
  // Provider pages use a single-page app. Script injection can run again after
  // the chat route changes while the delivery listener still holds this API
  // object, so refresh its methods in place instead of stranding that listener
  // on a stale adapter instance.
  const current = globalThis.NEURAFLOK_DEEPSEEK;
  if (current && typeof current === 'object') {
    Object.assign(current, api);
    return current;
  }
  return api;
})();
