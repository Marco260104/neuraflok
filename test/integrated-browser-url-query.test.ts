import { expect, it } from 'vitest';
import { matchesTabUrlPatterns } from '../backend/domains/browser/embedded/tabs/url-query-filter.js';

it('matches exact hosts and domain suffixes without matching lookalike names', () => {
  expect(matchesTabUrlPatterns('https://assistant.example/chat/1?view=full', 'https://assistant.example/*')).toBe(true);
  expect(matchesTabUrlPatterns('https://sub.assistant.example/', 'https://*.assistant.example/*')).toBe(true);
  expect(matchesTabUrlPatterns('https://assistant.example/', 'https://*.assistant.example/*')).toBe(true);
  expect(matchesTabUrlPatterns('https://evilassistant.example/', 'https://*.assistant.example/*')).toBe(false);
});

it('limits wildcard schemes and all-url matches to supported URL protocols', () => {
  expect(matchesTabUrlPatterns('http://assistant.example/', '*://assistant.example/*')).toBe(true);
  expect(matchesTabUrlPatterns('https://assistant.example/', '*://assistant.example/*')).toBe(true);
  expect(matchesTabUrlPatterns('ftp://assistant.example/file', '*://assistant.example/*')).toBe(false);
  expect(matchesTabUrlPatterns('ftp://assistant.example/file', '<all_urls>')).toBe(true);
  expect(matchesTabUrlPatterns('file:///Users/example/report.txt', 'file:///Users/*')).toBe(true);
  expect(matchesTabUrlPatterns('chrome://extensions/', '<all_urls>')).toBe(false);
});

it('matches explicit ports and checks paths with query strings but without fragments', () => {
  expect(matchesTabUrlPatterns('http://127.0.0.1:8765/status', 'http://127.0.0.1/*')).toBe(true);
  expect(matchesTabUrlPatterns('http://127.0.0.1:8765/status', 'http://127.0.0.1:8765/status')).toBe(true);
  expect(matchesTabUrlPatterns('http://127.0.0.1:8765/status', 'http://127.0.0.1:8766/*')).toBe(false);
  expect(matchesTabUrlPatterns('https://assistant.example/chat?tab=2#messages', 'https://assistant.example/chat?tab=*')).toBe(true);
  expect(matchesTabUrlPatterns('https://assistant.example/chat#messages', 'https://assistant.example/chat#messages')).toBe(false);
});

it('rejects invalid URLs and malformed patterns while checking every candidate', () => {
  expect(matchesTabUrlPatterns('', ['https://assistant.example/*'])).toBe(false);
  expect(matchesTabUrlPatterns('https://assistant.example/', 'not a pattern')).toBe(false);
  expect(matchesTabUrlPatterns('https://assistant.example/', 'https://assistant.example')).toBe(false);
  expect(matchesTabUrlPatterns('https://assistant.example/', 'https://*.assistant.*/*')).toBe(false);
  expect(matchesTabUrlPatterns('https://assistant.example/', ['not a pattern', 'https://assistant.example/*'])).toBe(true);
});
