import { describe, expect, it } from 'vitest';
import { invokedSkills, skillDirectives } from '../contracts/skills/invocation.js';

describe('skill invocation directives', () => {
  it('consumes only the initial command block and preserves the authored body', () => {
    expect(skillDirectives('  /review\n/prompt audit\nDo this /other')).toEqual({
      ids: ['review', 'audit'],
      prefix: '  /review\n/prompt audit\n',
      body: 'Do this /other'
    });
  });

  it('keeps paths, punctuation and prose as literal text', () => {
    for (const text of ['/project/file.md', '/review!', 'Do /review']) {
      expect(skillDirectives(text)).toEqual({ ids: [], prefix: '', body: text });
    }
  });

  it('deduplicates selected names while retaining every directive in the prefix', () => {
    expect(skillDirectives('/review /review task')).toEqual({
      ids: ['review'],
      prefix: '/review /review ',
      body: 'task'
    });
  });

  it('requires a skill after the prompt alias and validates the resulting identifier', () => {
    expect(() => skillDirectives('/prompt')).toThrow(/Choose a skill/);
    expect(() => skillDirectives('/review.')).toThrow(/Invalid skill/);
  });

  it('limits distinct selections to sixty-four', () => {
    const commands = Array.from({ length: 65 }, (_, index) => `/skill-${index}`).join(' ');
    expect(() => skillDirectives(commands)).toThrow(/Too many selected skills/);
  });

  it('provides the selected identifiers through the compact API', () => {
    expect(invokedSkills('/review /prompt audit task')).toEqual(['review', 'audit']);
  });
});
