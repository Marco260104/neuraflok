import { appendFileSync } from 'node:fs';
import path from 'node:path';

// Report every test that fails before passing on a CI retry.
export default class FlakyReporter {
  constructor({ output = line => console.log(line), summary = process.env.NEURAFLOK_CI_SUMMARY } = {}) {
    this.output = output;
    this.summary = summary;
    this.flaky = [];
  }

  onTestCaseResult(testCase) {
    if (!testCase.diagnostic()?.flaky) return;
    this.flaky.push(`${path.relative(process.cwd(), testCase.module.moduleId).split(path.sep).join('/')} > ${testCase.fullName}`);
  }

  onTestRunEnd() {
    if (!this.flaky.length) return;
    for (const name of this.flaky) this.output(`Flaky test: ${name} failed once and passed on retry`);
    if (this.summary) {
      appendFileSync(this.summary, `### Flaky tests\n\nThese failed once and passed on retry:\n\n${this.flaky.map(name => `- ${name}`).join('\n')}\n`);
    }
  }
}
