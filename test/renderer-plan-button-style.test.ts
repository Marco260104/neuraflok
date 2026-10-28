import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const styles = readFileSync('frontend/styles/automation-and-composer.css', 'utf8');

it('shows a clear Plan toggle state and keeps the control hidden outside project chats', () => {
  expect(styles).toContain('.composer .composer-goal-pill.is-active');
  expect(styles).toContain(".composer .composer-goal-pill[aria-pressed='true']");
  expect(styles).toContain('0 1px 2px color-mix(in srgb, var(--page) 28%, transparent)');
  expect(styles).toContain('--plan-active-fill: #f4f4f5');
  expect(styles).not.toContain('0 0 12px color-mix(in srgb, var(--accent) 38%, transparent)');
  expect(styles).toContain('.composer .composer-goal-pill[hidden] { display: none; }');
  expect(styles).toContain('#composerPlanBtn > span');
});
