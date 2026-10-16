import { readRendererMarkup } from '../scripts/read-renderer-markup.cjs';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';

// Languages read as a list people scan by their own language's name: European languages first, then Japanese, Korean and Chinese. A new language is sorted in, not appended.
const ORDER = ['de', 'en', 'es', 'fr', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'ja', 'ko', 'zh-CN', 'zh-TW'];

it('lists languages in native-name order in Settings', () => {
  const page = new JSDOM(readRendererMarkup(process.cwd()));
  const doc = page.window.document;
  expect([...doc.querySelectorAll<HTMLOptionElement>('#uiLanguage option')].map(option => option.value)).toEqual(ORDER);
  page.window.close();
});
