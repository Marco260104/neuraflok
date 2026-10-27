import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const styles = readFileSync('frontend/styles/automation-and-composer.css', 'utf8');

it('shows a clear Plan toggle state and keeps the control hidden outside project chats', () => {
  expect(styles).toContain('.composer .composer-goal-pill.is-active');
  expect(styles).toContain(".composer .composer-goal-pill[aria-pressed='true']");
  expect(styles).toContain('.composer .composer-goal-pill[hidden] { display: none; }');
  expect(styles).toContain('#composerPlanBtn > span');
});
