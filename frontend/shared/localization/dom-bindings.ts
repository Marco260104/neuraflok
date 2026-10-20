import {
  isCatalogMessage,
  isNormalizedCatalogMessage,
  type Language
} from './catalog.js';

type UiProperty = 'textContent' | 'title' | 'placeholder' | 'aria-label' | 'aria-valuetext' | 'data-usage-hint';
type UiBinding = { read: () => string; last: string };
type LanguageRuntime = {
  current: () => Language;
  parse: (value: string | null | undefined) => Language;
  set: (language: Language) => void;
  translate: (source: string) => string;
};

const bindings = new WeakMap<Node, Map<UiProperty, UiBinding>>();
const initializedSelects = new WeakSet<HTMLSelectElement>();
const initializedButtons = new WeakSet<HTMLButtonElement>();

function readValue(node: Node, property: UiProperty): string | null {
  return property === 'textContent' ? node.textContent : (node as Element).getAttribute(property);
}

function writeValue(node: Node, property: UiProperty, value: string): void {
  if (property === 'textContent') node.textContent = value;
  else (node as Element).setAttribute(property, value);
}

export function ui<T extends Node>(node: T, property: UiProperty, value: () => string): T {
  if (!node || typeof node !== 'object') return node;
  let properties = bindings.get(node);
  if (!properties) {
    properties = new Map();
    bindings.set(node, properties);
  }
  const current = value();
  properties.set(property, { read: value, last: current });
  writeValue(node, property, current);
  return node;
}

export function uiText(value: () => string): Text {
  return ui(document.createTextNode(''), 'textContent', value);
}

export function refreshLanguageBindings(): void {
  const walker = document.createTreeWalker(document.body, 1 | 4);
  do {
    const node = walker.currentNode;
    const properties = bindings.get(node);
    if (!properties) continue;
    for (const [property, binding] of properties) {
      if (readValue(node, property) !== binding.last) {
        properties.delete(property);
        continue;
      }
      const next = binding.read();
      binding.last = next;
      writeValue(node, property, next);
    }
  } while (walker.nextNode());
}

function bindStaticText(runtime: LanguageRuntime): void {
  const walker = document.createTreeWalker(document.body, 4);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  for (const node of nodes) {
    if (node.parentElement?.closest('script, style, svg, code, kbd, textarea, [translate="no"]')) continue;
    const source = node.data;
    const key = source.replace(/\s+/g, ' ').trim();
    if (isNormalizedCatalogMessage(key)) {
      ui(node, 'textContent', () => source.replace(/\S[\s\S]*\S|\S/, runtime.translate(key)));
    }
  }

  for (const node of document.querySelectorAll<HTMLElement>('[title], [placeholder], [aria-label]')) {
    if (node.closest('[translate="no"]')) continue;
    for (const property of ['title', 'placeholder', 'aria-label'] as const) {
      const source = node.getAttribute(property);
      if (source && isCatalogMessage(source)) ui(node, property, () => runtime.translate(source));
    }
  }
}

export function syncLanguageControls(language: Language): void {
  const select = document.getElementById('uiLanguage') as HTMLSelectElement | null;
  if (select) select.value = language;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-language]')) {
    button.setAttribute('aria-pressed', String(button.dataset.language === language));
  }
}

export function initializeLanguageDocument(runtime: LanguageRuntime): void {
  bindStaticText(runtime);
  document.documentElement.lang = runtime.current();
  syncLanguageControls(runtime.current());

  const select = document.getElementById('uiLanguage') as HTMLSelectElement | null;
  if (select && !initializedSelects.has(select)) {
    initializedSelects.add(select);
    select.addEventListener('change', () => runtime.set(runtime.parse(select.value)));
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-language]')) {
    if (initializedButtons.has(button)) continue;
    initializedButtons.add(button);
    button.addEventListener('click', () => runtime.set(runtime.parse(button.dataset.language)));
  }
}
