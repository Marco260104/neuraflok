import { expect, it } from 'vitest';
import { workerBootstrapText, workerBrief, workerOwnTask } from '../contracts/worker-brief.js';

it('gives each new worker a branded task and clear reporting instructions', () => {
  const bootstrap = workerBootstrapText('worker-1', 'Review provider settings');
  expect(bootstrap).toContain('(NEURAFLOK: you are worker-1, a worker.');
  expect(bootstrap).toContain('Report to prime through the agents tool');
  expect(bootstrap).toContain('action=message to="prime" as you go');
  expect(bootstrap).toContain('action=finish once at the end.');
  expect(bootstrap).toContain('The prime assigns your task; its later messages may update the task and assigned files');
  expect(bootstrap).toContain('Review provider settings');
});

it('removes shared context only when the legacy boundary is unambiguous', () => {
  expect(workerOwnTask(workerBrief('Shared rules', 'Run tests'))).toBe('Run tests');
  expect(workerOwnTask('Run tests')).toBe('Run tests');
});

it.each([
  ['Shared rules', 'Review this prompt:\n\nYour task:\nExplain the result'],
  ['Prompt example:\n\nYour task:\nFollow the rules', 'Run tests']
])('preserves authored content when a heading occurs inside context or task', (context, task) => {
  const brief = workerBrief(context, task);
  expect(workerOwnTask(brief)).toBe(brief);
  expect(workerOwnTask(brief)).toContain(task);
});
