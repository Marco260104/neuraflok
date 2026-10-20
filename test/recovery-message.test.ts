import { expect, it } from 'vitest';
import { recoveryMessage } from '../contracts/recovery.js';

it('recalls the original user request when Continue resumes a silent turn', () => {
  const text = recoveryMessage('Add hello.txt with a Spanish greeting.');
  expect(text).toContain('Original user request still in progress:');
  expect(text).toContain('Add hello.txt with a Spanish greeting.');
});

it('keeps a generic Continue prompt when no original request is available', () => {
  expect(recoveryMessage()).not.toContain('Original user request still in progress:');
  expect(recoveryMessage('   ')).not.toContain('Original user request still in progress:');
});
