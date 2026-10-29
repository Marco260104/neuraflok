// Detect DeepSeek composer, conversation, answer, and send controls.
var NEURAFLOK_DEEPSEEK = (() => {
  const SEND_PATH = 'M8.3125 0.98';
  const STOP_PATH = 'M2 4.88';
  const ATTACH_PATH = 'M5.5498';
  const imageUploadQuietPolls = new Map();
  const imageUploadPreviewBaselines = new Map();
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

  // DeepSeek keeps the previous conversation DOM mounted briefly while its SPA
  // navigates to a fresh chat. The delivery agent uses this route key alongside
  // hasConversation() so those stale nodes cannot make a successful navigation
  // look like a failed New chat action.
  const pageIdentity = () => safe(() => {
    const url = new URL(location.href);
    return `${url.origin}${url.pathname}${url.hash}`;
  }, '');

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

  const fileInputs = () => queryOpenRoots(openShadowRoots(), 'input[type="file"]')
    .filter(input => input.disabled !== true && input.getAttribute?.('aria-disabled') !== 'true');

  const selectedAttachmentId = file => {
    try { return typeof file?.__neuraflokAttachmentId === 'string' ? file.__neuraflokAttachmentId : ''; }
    catch { return ''; }
  };
  const selectedFileMatches = (selected, requested) => {
    const selectedId = selectedAttachmentId(selected);
    if (selectedId && typeof requested?.id === 'string') return selectedId === requested.id;
    return selected?.name === requested?.name && selected?.type === requested?.mimeType &&
      (typeof requested?.size !== 'number' || selected?.size === requested.size);
  };

  const attachmentReceiptKey = conversationId => {
    const id = typeof conversationId === 'string' ? conversationId.trim() : '';
    return /^[a-z0-9-]{8,128}$/i.test(id) ? `neuraflok.deepseekAttachmentReceipts.${id}` : '';
  };
  const confirmedAttachmentIds = conversationId => {
    const key = attachmentReceiptKey(conversationId);
    if (!key) return new Set();
    try {
      const value = JSON.parse(sessionStorage.getItem(key) || '[]');
      return new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string') : []);
    } catch { return new Set(); }
  };
  const attachmentsConfirmed = (files, conversationId) => {
    if (!Array.isArray(files) || !files.length) return false;
    const confirmed = confirmedAttachmentIds(conversationId);
    return files.every(file => typeof file?.id === 'string' && confirmed.has(file.id));
  };
  const clearAttachmentReceipt = conversationId => {
    const key = attachmentReceiptKey(conversationId);
    if (!key) return false;
    try {
      sessionStorage.removeItem(key);
      const prefix = `${conversationId}:`;
      for (const receipt of imageUploadQuietPolls.keys()) if (receipt.startsWith(prefix)) imageUploadQuietPolls.delete(receipt);
      for (const receipt of imageUploadPreviewBaselines.keys()) if (receipt.startsWith(prefix)) imageUploadPreviewBaselines.delete(receipt);
      return true;
    } catch { return false; }
  };
  const confirmAttachmentsUploaded = (files, conversationId) => {
    const key = attachmentReceiptKey(conversationId);
    if (!key || !Array.isArray(files) || !files.length || files.some(file => typeof file?.id !== 'string')) return false;
    try {
      const confirmed = confirmedAttachmentIds(conversationId);
      for (const file of files) confirmed.add(file.id);
      sessionStorage.setItem(key, JSON.stringify([...confirmed].slice(-200)));
      tagUploadedImagePreviews(files, conversationId);
      for (const file of files) {
        const receipt = imagePreviewKey(conversationId, file);
        imageUploadQuietPolls.delete(receipt);
        imageUploadPreviewBaselines.delete(receipt);
      }
      return true;
    } catch { return false; }
  };

  const attachmentContainers = () => {
    const box = composer();
    if (!box) return [];
    const containers = [
      box.closest('form'), box.closest('.ds-input'), box.closest('[class*="composer"]'),
    ];
    // DeepSeek has moved its pending-file chips outside `.ds-input` in some
    // composer layouts. Include a short chain of nearby ancestors so the
    // current draft card (and its progress indicator) remains discoverable.
    // Stop before the message history so an older attachment cannot be
    // mistaken for the file being uploaded now.
    let current = box;
    for (let depth = 0; current && depth < 7; depth += 1) {
      const marker = `${current.className || ''} ${current.getAttribute?.('data-testid') || ''}`;
      if (depth > 1 && /(?:message[-_ ]?list|conversation[-_ ]?history|chat[-_ ]?history|virtual[-_ ]?list)/i.test(marker)) break;
      containers.push(current);
      current = current.parentElement || current.parent || safe(() => current.getRootNode?.().host, null) || null;
    }
    return [...new Set(containers.filter(Boolean))];
  };
  const attachmentNodeText = node => `${node.innerText || node.textContent || ''} ${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''}`
    .toLocaleLowerCase();
  const attachmentSizeMatches = (file, text) => {
    if (!(Number(file?.size) > 0)) return false;
    const units = { b: [1, 1], kb: [1_000, 1_024], kib: [1_024, 1_024], mb: [1_000_000, 1_048_576], mib: [1_048_576, 1_048_576], gb: [1_000_000_000, 1_073_741_824], gib: [1_073_741_824, 1_073_741_824] };
    const matches = text.matchAll(/([\d.,]+)\s*(B|KB|KIB|MB|MIB|GB|GIB)\b/gi);
    for (const match of matches) {
      const shown = Number(match[1].replace(',', '.'));
      const factors = units[match[2].toLowerCase()];
      if (!Number.isFinite(shown) || !factors) continue;
      if (factors.some(factor => Math.abs(shown * factor - file.size) <= Math.max(factor * 0.051, file.size * 0.03))) return true;
    }
    return false;
  };
  const attachmentTypeMatches = (file, text) => {
    if (file?.mimeType === 'application/pdf' || /\.pdf$/i.test(file?.name || '')) return /\bpdf\b/i.test(text);
    if (String(file?.mimeType || '').startsWith('image/')) {
      const extension = String(file?.name || '').match(/\.([^.]+)$/)?.[1]?.toLowerCase() || '';
      const labels = { jpeg: /\b(?:jpeg|jpg|image|photo)\b/i, jpg: /\b(?:jpeg|jpg|image|photo)\b/i,
        png: /\b(?:png|image|photo)\b/i, webp: /\b(?:webp|image|photo)\b/i, gif: /\b(?:gif|image|photo)\b/i };
      return (labels[extension] || /\b(?:image|photo|picture)\b/i).test(text);
    }
    return false;
  };
  const attachmentChipFor = (file, container) => {
    if (!container || typeof file?.name !== 'string' || !file.name) return null;
    const nodes = [container, ...safe(() => [...container.querySelectorAll('*')], [])]
      .filter(node => visible(node, true));
    const tagged = typeof file.id === 'string'
      ? nodes.find(node => node.__neuraflokAttachmentId === file.id)
      : null;
    if (tagged) return tagged;
    const name = file.name.toLocaleLowerCase();
    const stem = name.replace(/\.[^.]*$/, '');
    const prefixLength = Math.min(stem.length, 10);
    const prefix = prefixLength >= 5 ? stem.slice(0, prefixLength) : name;
    const candidates = nodes.filter(node => {
      const text = attachmentNodeText(node);
      return text.includes(name) || (prefixLength >= 5 && text.includes(prefix));
    }).sort((left, right) => attachmentNodeText(left).length - attachmentNodeText(right).length);
    for (const candidate of candidates) {
      let scope = candidate;
      for (let depth = 0; scope && depth < 7; depth += 1) {
        const text = attachmentNodeText(scope);
        const hasName = text.includes(name) || (prefixLength >= 5 && text.includes(prefix));
        const hasMetadata = attachmentTypeMatches(file, text) || attachmentSizeMatches(file, text);
        const looksLikeCard = /(?:file|attachment|upload)/i.test(`${scope.className || ''} ${scope.getAttribute?.('data-testid') || ''}`);
        const hasRemoveControl = safe(() => [scope, ...scope.querySelectorAll('*')].some(node =>
          (String(node.tagName || '').toUpperCase() === 'BUTTON' || node.getAttribute?.('role') === 'button') &&
          /(?:remove|delete|discard|close|eliminar|quitar|borrar|cerrar|supprimer|entfernen|删除|移除)/i.test(labelOf(node))), false);
        if (hasName && (hasMetadata || looksLikeCard || hasRemoveControl)) return scope;
        if (scope === container) break;
        scope = scope.parentElement || scope.parent || null;
      }
      // A full, untruncated filename is a reliable match even when DeepSeek's
      // card omits type/size text from the accessible DOM.
      if (attachmentNodeText(candidate).includes(name)) return candidate;
    }
    return null;
  };
  const attachmentChipMatches = (file, container) => Boolean(attachmentChipFor(file, container));
  const attachmentChipsPresent = (files, container) => {
    if (!Array.isArray(files) || !files.length) return false;
    const containers = container ? [container] : attachmentContainers();
    return containers.some(root => files.every(file => attachmentChipMatches(file, root)));
  };
  const attachmentUploadState = (files, container) => {
    if (!container) return 'pending';
    let unknownProgress = false;
    const progressValue = node => {
      const currentValue = node.getAttribute?.('aria-valuenow') ?? node.value;
      const maximumValue = node.getAttribute?.('aria-valuemax') ?? node.max ?? 100;
      const current = Number(currentValue);
      const maximum = Number(maximumValue);
      if (Number.isFinite(current) && Number.isFinite(maximum)) return current < maximum;
      const width = String(node.style?.width || '').match(/^\s*([\d.]+)%/);
      if (width) return Number(width[1]) < 100;
      return null;
    };
    const hasActiveState = node => {
      if (!visible(node, true)) return false;
      const role = String(node.getAttribute?.('role') || '').toLowerCase();
      const state = [node.className, node.getAttribute?.('data-state'), node.getAttribute?.('data-testid'),
        node.getAttribute?.('aria-label')].filter(Boolean).join(' ');
      if (/\b(?:complete|completed|done|ready|success)\b/i.test(state)) return false;
      if (node.getAttribute?.('aria-busy') === 'true') return true;
      const text = String(node.innerText || node.textContent || '').toLocaleLowerCase();
      const remainingText = files.reduce((value, file) =>
        typeof file?.name === 'string' ? value.replaceAll(file.name.toLocaleLowerCase(), ' ') : value, text);
      if (/(?:^|[\s_-])(?:is-)?(?:uploading|loading|processing|pending|in-progress)(?=$|[\s_-])/i.test(state) ||
          /\b(?:uploading|loading|processing|pending|cargando|subiendo|carregando|chargement|upload en cours)\b/i.test(remainingText)) return true;
      const isProgress = role === 'progressbar' || node.tagName === 'PROGRESS' ||
        /(?:^|[\s_-])(?:progressbar|(?:upload|file|attachment)[-_]progress)(?=$|[\s_-])/i.test(state);
      if (!isProgress) return false;
      const value = progressValue(node);
      if (value === null) { unknownProgress = true; return false; }
      return value;
    };
    for (const file of files) {
      const name = typeof file?.name === 'string' ? file.name.toLocaleLowerCase() : '';
      if (!name) return 'pending';
      const scope = attachmentChipFor(file, container);
      if (!scope) return 'pending';
      const related = [scope, ...safe(() => [...scope.querySelectorAll('*')], [])];
      const parent = scope.parentElement || scope.parent || null;
      if (parent) {
        for (const sibling of safe(() => [...parent.children], [])) {
          if (sibling === scope || !visible(sibling, true)) continue;
          const marker = `${sibling.className || ''} ${sibling.getAttribute?.('data-testid') || ''} ${sibling.getAttribute?.('role') || ''} ${sibling.getAttribute?.('aria-label') || ''}`;
          if (!/(?:progress|upload|loading|spinner)/i.test(marker) && sibling.getAttribute?.('aria-busy') !== 'true') continue;
          related.push(sibling, ...safe(() => [...sibling.querySelectorAll('*')], []));
        }
      }
      if (related.some(hasActiveState)) return 'pending';
    }
    return unknownProgress ? 'unknown' : 'idle';
  };
  const imagePreviewNodes = container => {
    if (!container) return [];
    const nodes = [container, ...safe(() => [...container.querySelectorAll('*')], [])];
    const imageNodes = nodes.filter(node => {
      if (!visible(node, true)) return false;
      const tag = String(node.tagName || '').toUpperCase();
      const marker = `${node.className || ''} ${node.getAttribute?.('data-testid') || ''}`;
      const src = String(node.getAttribute?.('src') || node.src || '');
      return (tag === 'IMG' && /^(?:blob:|data:image\/)/i.test(src)) ||
        (tag === 'CANVAS' && /(?:blob:|data:image\()/i.test(String(node.style?.backgroundImage || src)));
    });
    if (imageNodes.length) return imageNodes;
    return nodes.filter(node => {
      if (!visible(node, true)) return false;
      const marker = `${node.className || ''} ${node.getAttribute?.('data-testid') || ''}`;
      return /(?:image|photo|picture|preview)/i.test(marker) &&
        /(?:blob:|data:image\()/i.test(String(node.style?.backgroundImage || node.getAttribute?.('src') || ''));
    });
  };
  const imagePreviewCount = container => imagePreviewNodes(container).length;
  const imagePreviewPresent = container => imagePreviewCount(container) > 0;
  const imagePreviewKey = (conversationId, file) => `${conversationId}:${file.id || file.name}`;
  const imagePreviewsAdded = (files, conversationId, containers) => {
    if (!files.length || !containers.length) return false;
    const baseline = Math.max(-1, ...files.map(file => imageUploadPreviewBaselines.get(imagePreviewKey(conversationId, file)) ?? -1));
    if (baseline < 0) return false;
    const current = Math.max(0, ...containers.map(imagePreviewCount));
    return current >= baseline + files.length;
  };
  const prepareImageAttachmentUpload = (files, conversationId) => {
    if (!Array.isArray(files) || !files.length) return false;
    const baseline = Math.max(0, ...attachmentContainers().map(imagePreviewCount));
    for (const file of files) {
      if (!String(file?.mimeType || '').startsWith('image/')) continue;
      const key = imagePreviewKey(conversationId, file);
      if (!imageUploadPreviewBaselines.has(key)) imageUploadPreviewBaselines.set(key, baseline);
      imageUploadQuietPolls.delete(key);
    }
    return true;
  };
  const tagUploadedImagePreviews = (files, conversationId) => {
    const containers = attachmentContainers();
    let imageOffset = 0;
    for (const file of files) {
      if (!String(file?.mimeType || '').startsWith('image/')) continue;
      const baseline = imageUploadPreviewBaselines.get(imagePreviewKey(conversationId, file));
      if (baseline === undefined) continue;
      const container = containers.find(root => imagePreviewCount(root) > baseline);
      const preview = container ? imagePreviewNodes(container)[baseline + imageOffset] : null;
      if (!preview) continue;
      imageOffset += 1;
      let card = preview;
      for (let scope = preview, depth = 0; scope && depth < 7; scope = scope.parentElement || scope.parent || null, depth += 1) {
        const hasRemoveControl = safe(() => [scope, ...scope.querySelectorAll('*')].some(node =>
          (String(node.tagName || '').toUpperCase() === 'BUTTON' || node.getAttribute?.('role') === 'button') &&
          /(?:remove|delete|discard|close|eliminar|quitar|borrar|cerrar|supprimer|entfernen|删除|移除)/i.test(labelOf(node))), false);
        if (hasRemoveControl) { card = scope; break; }
        if (scope === container) break;
      }
      try { Object.defineProperty(card, '__neuraflokAttachmentId', { value: file.id, configurable: true }); }
      catch { try { card.__neuraflokAttachmentId = file.id; } catch {} }
    }
  };
  const imageUploadInProgress = (container, files) => {
    if (!container) return true;
    const nodes = [container, ...safe(() => [...container.querySelectorAll('*')], [])];
    return nodes.some(node => {
      if (!visible(node, true)) return false;
      const role = String(node.getAttribute?.('role') || '').toLowerCase();
      const state = [node.className, node.getAttribute?.('data-state'), node.getAttribute?.('data-testid'),
        node.getAttribute?.('aria-label')].filter(Boolean).join(' ');
      if (/\b(?:complete|completed|done|ready|success)\b/i.test(state)) return false;
      const text = String(node.innerText || node.textContent || '').toLocaleLowerCase();
      const remainingText = files.reduce((value, file) =>
        typeof file?.name === 'string' ? value.replaceAll(file.name.toLocaleLowerCase(), ' ') : value, text);
      if (/(?:upload|file|attachment).*(?:fail|error)|(?:fail|error).*(?:upload|file|attachment)|no se pudo cargar/i.test(`${state} ${remainingText}`)) return true;
      if (node.getAttribute?.('aria-busy') === 'true' ||
          /(?:^|[\s_-])(?:is-)?(?:uploading|loading|processing|pending|in-progress)(?=$|[\s_-])/i.test(state)) return true;
      if (/\b(?:uploading|loading|processing|pending|cargando|subiendo|carregando|chargement|upload en cours)\b/i.test(remainingText)) return true;
      const progress = role === 'progressbar' || node.tagName === 'PROGRESS' || /(?:progressbar|(?:upload|file|attachment)[-_]progress)/i.test(state);
      if (!progress) return false;
      const current = Number(node.getAttribute?.('aria-valuenow') ?? node.value);
      const maximum = Number(node.getAttribute?.('aria-valuemax') ?? node.max ?? 100);
      if (Number.isFinite(current) && Number.isFinite(maximum)) return current < maximum;
      const width = String(node.style?.width || '').match(/^\s*([\d.]+)%/);
      return width ? Number(width[1]) < 100 : false;
    });
  };
  const attachmentUploadReady = (files, conversationId) => {
    if (!Array.isArray(files) || !files.length) return false;
    if (attachmentsConfirmed(files, conversationId)) return true;
    if (!attachmentsPresent(files, conversationId)) return false;
    const containers = attachmentContainers();
    const container = containers.find(root => attachmentChipsPresent(files, root));
    if (!container) {
      // DeepSeek renders images as thumbnails in some composer versions, with
      // no filename text to match against. In that layout the selected native
      // file plus its visible preview and settled upload state are the receipt.
      const imagesOnly = files.every(file => String(file?.mimeType || '').startsWith('image/'));
      const previewContainer = imagesOnly ? containers.find(imagePreviewPresent) : null;
      if (!previewContainer || !imagePreviewsAdded(files, conversationId, containers)) return false;
      const key = `${conversationId}:${files.map(file => file.id || file.name).join('|')}`;
      if (imageUploadInProgress(previewContainer, files)) {
        imageUploadQuietPolls.delete(key);
        return false;
      }
      const quietPolls = (imageUploadQuietPolls.get(key) || 0) + 1;
      if (quietPolls < 4) {
        imageUploadQuietPolls.set(key, quietPolls);
        return false;
      }
      imageUploadQuietPolls.delete(key);
      return true;
    }
    // The provider's visible file card is the receipt. Keep polling its DOM
    // state so the UI turns ready as soon as DeepSeek finishes or removes its
    // upload indicator, without an arbitrary timer.
    const state = attachmentUploadState(files, container);
    if (state === 'idle') return true;
    // Some DeepSeek builds leave an indeterminate progressbar mounted after
    // completing the upload. A matching card that exposes the truncated name,
    // file type, and exact size is stronger evidence than that stale marker.
    if (state === 'unknown') return files.every(file => {
      const card = attachmentChipFor(file, container);
      if (!card) return false;
      const text = attachmentNodeText(card);
      return attachmentTypeMatches(file, text) && attachmentSizeMatches(file, text);
    });
    return false;
  };

  const selectedAttachmentsPresent = files => {
    if (!Array.isArray(files) || !files.length) return false;
    const selected = fileInputs().flatMap(input => Array.from(input.files || []));
    return files.some(file => selected.some(item => selectedFileMatches(item, file)));
  };
  const providerAttachmentsPresent = files => selectedAttachmentsPresent(files) || attachmentChipsPresent(files);
  const removeAttachmentFiles = files => {
    if (!Array.isArray(files) || !files.length) return false;
    const containers = attachmentContainers();
    for (const file of files) {
      const card = containers.map(container => attachmentChipFor(file, container)).find(Boolean);
      // Never acknowledge removal when we did not find the provider's chip.
      // The app keeps the local attachment until this remote removal succeeds.
      if (!card) return false;
      const descendants = [card, ...safe(() => [...card.querySelectorAll('*')], [])];
      const controls = descendants.filter(node => visible(node, true) &&
        (String(node.tagName || '').toUpperCase() === 'BUTTON' || node.getAttribute?.('role') === 'button'));
      const removeLabel = /(?:remove|delete|discard|close|eliminar|quitar|borrar|cerrar|supprimer|entfernen|删除|移除)/i;
      const labeled = controls.find(node => removeLabel.test(labelOf(node)));
      const closeGlyph = controls.filter(node => /^(?:×|✕|x|close)$/i.test(String(node.textContent || '').replace(/\s+/g, '').trim()));
      const classMarked = controls.filter(node => /(?:remove|delete|close)/i.test(String(node.className || '')));
      const control = labeled || closeGlyph[0] || classMarked[0] || (controls.length === 1 ? controls[0] : null);
      if (!control || typeof control.click !== 'function') return false;
      try { control.click(); } catch { return false; }
    }

    // The native input is only a local staging buffer. Remove just the
    // requested files from it while keeping any other files selected by the
    // user, so DeepSeek cannot silently re-upload a removed item later.
    const inputs = fileInputs();
    for (const input of inputs) {
      const selected = Array.from(input.files || []);
      if (!selected.some(item => files.some(file => selectedFileMatches(item, file)))) continue;
      try {
        if (typeof DataTransfer === 'function') {
          const transfer = new DataTransfer();
          for (const item of selected) {
            if (!files.some(file => selectedFileMatches(item, file))) transfer.items.add(item);
          }
          input.files = transfer.files;
        } else if (selected.every(item => files.some(file => selectedFileMatches(item, file)))) {
          input.value = '';
        } else return false;
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } catch { return false; }
    }
    return true;
  };
  const attachmentsRemoved = (files, conversationId) => {
    if (providerAttachmentsPresent(files)) return false;
    for (const file of files) {
      const receipt = imagePreviewKey(conversationId, file);
      imageUploadQuietPolls.delete(receipt);
      imageUploadPreviewBaselines.delete(receipt);
    }
    const key = attachmentReceiptKey(conversationId);
    if (key) {
      try {
        const confirmed = confirmedAttachmentIds(conversationId);
        for (const file of files) confirmed.delete(file.id);
        if (confirmed.size) sessionStorage.setItem(key, JSON.stringify([...confirmed].slice(-200)));
        else sessionStorage.removeItem(key);
      } catch {}
    }
    return true;
  };

  const attachFiles = (files, conversationId) => {
    if (!Array.isArray(files) || !files.length) return false;
    if (attachmentsConfirmed(files, conversationId)) return true;
    if (typeof DataTransfer !== 'function' || typeof File !== 'function') return false;
    const input = fileInputs().find(node => {
      const accept = String(node.getAttribute?.('accept') || '').toLowerCase();
      return !accept || files.every(file => accept.includes(file.mimeType) ||
        (file.mimeType === 'application/pdf' && accept.includes('.pdf')) ||
        (file.mimeType.startsWith('image/') && accept.includes('image/*')));
    });
    if (!input) return false;
    const transfer = new DataTransfer();
    try {
      const selectedFiles = fileInputs().flatMap(node => Array.from(node.files || []));
      const existingKeys = new Set();
      const addOnce = file => {
        const id = selectedAttachmentId(file);
        const key = id ? `id:${id}` : `file:${file.name}\0${file.type}\0${file.size}`;
        if (existingKeys.has(key)) return;
        existingKeys.add(key);
        transfer.items.add(file);
      };
      // DeepSeek keeps uploaded chips in its own composer state. Re-selecting
      // old files when adding one more makes the site upload them again, so
      // only carry forward native selections that have not appeared as chips.
      const unconfirmedSelections = selectedFiles.filter(file => !attachmentsPresent([{
        id: selectedAttachmentId(file), name: file.name, mimeType: file.type, size: file.size
      }], conversationId));
      for (const file of unconfirmedSelections) addOnce(file);
      const missing = files.filter(file => !attachmentsConfirmed([file], conversationId) && !attachmentsPresent([file], conversationId));
      prepareImageAttachmentUpload(missing, conversationId);
      for (const file of missing) {
        if (!file || !Array.isArray(file.chunks) || !file.chunks.every(chunk => typeof chunk === 'string')) return false;
        const parts = file.chunks.map(chunk => {
          const binary = atob(chunk);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          return bytes;
        });
        const created = new File(parts, file.name, { type: file.mimeType });
        if (typeof file.id === 'string') {
          try { Object.defineProperty(created, '__neuraflokAttachmentId', { value: file.id, configurable: true }); }
          catch {}
        }
        addOnce(created);
      }
      if (!missing.length) return true;
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return true;
    } catch {
      return false;
    }
  };

  const attachmentsPresent = (files, conversationId) => {
    if (!Array.isArray(files) || !files.length) return false;
    if (attachmentsConfirmed(files, conversationId)) return true;
    // DeepSeek can clear its native file input after creating the file card,
    // and its card can truncate the filename. Accept either the native input
    // selection or the visible provider card as evidence the file was staged.
    const selectedFiles = fileInputs().flatMap(input => Array.from(input.files || []));
    if (files.every(file => selectedFiles.some(selected => selectedFileMatches(selected, file)))) return true;
    if (attachmentChipsPresent(files)) return true;
    return files.every(file => String(file?.mimeType || '').startsWith('image/')) &&
      imagePreviewsAdded(files, conversationId, attachmentContainers());
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
    attachFiles,
    attachmentsPresent,
    attachmentUploadReady,
    removeAttachmentFiles,
    providerAttachmentsPresent,
    attachmentsRemoved,
    attachmentsConfirmed,
    clearAttachmentReceipt,
    confirmAttachmentsUploaded,
    prepareImageAttachmentUpload,
    hasConversation,
    pageIdentity,
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
