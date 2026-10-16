import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

async function waitForReport(fixture, accept, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  let report;
  do {
    report = await fixture.request('report');
    if (accept(report)) return report;
    await delay(25);
  } while (performance.now() < deadline);
  return report;
}

export async function verifyTextInput({ request, fixture, target }) {
  await fixture.request('edit');
  const multiline = await request({
    op: 'act',
    targetWindow: target,
    actions: [{ type: 'type', text: 'a\nb\r\nc' }]
  });
  assert.equal(multiline.ok, false, JSON.stringify(multiline));
  assert.equal(multiline.error_code, 'MULTILINE_REQUIRES_PASTE', JSON.stringify(multiline));
  assert.equal((await fixture.request('report')).text, '', 'Rejected multiline input partially reached the fixture');

  const text = 'Computer use test: Hello123';
  const typed = await request({ op: 'act', targetWindow: target, actions: [{ type: 'type', text }] });
  assert.equal(typed.ok, true, JSON.stringify(typed));
  const report = await waitForReport(fixture, state => state.text === text);
  assert.equal(report.text, text);
  assert.equal(report.enterKeys, 0, 'Literal text generated a Return keypress');

  return { multilineError: multiline.error_code, report };
}

export async function verifyClipboardPaste({ runElectron, fixture }) {
  const saved = await fixture.request('save-clipboard');
  if (saved.ok !== true) {
    return { status: 'skipped', reason: saved.error, clipboardChanged: false };
  }

  assert.equal(saved.clipboardSaved, true);
  await fixture.request('paste-ready');
  let pasted;
  let report;
  let restored;

  try {
    pasted = await runElectron('paste');
    assert.equal(pasted.ok, true, JSON.stringify(pasted));
    assert.equal(pasted.result.completedCount, 1);
    report = await waitForReport(fixture, state => state.text.replaceAll('\r\n', '\n') === 'a\nb\nc');
    assert.equal(report.text.replaceAll('\r\n', '\n'), 'a\nb\nc');
    assert.equal(report.enterKeys, 0, 'Multiline paste generated a Return keypress');
    assert.equal(report.pasteCount, 1);
  } finally {
    restored = await fixture.request('restore-clipboard');
  }

  return {
    status: 'passed',
    completedCount: pasted.result.completedCount,
    pasteCount: report.pasteCount,
    enterKeys: report.enterKeys,
    clipboardRestored: restored.clipboardRestored
  };
}
