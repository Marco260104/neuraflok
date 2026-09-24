export interface RecommendedSkill {
  id: string;
  name: string;
  description: string;
  markdown: string;
}

function skill(id: string, name: string, description: string, guidance: string): RecommendedSkill {
  const metadata = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---`;
  return { id, name, description, markdown: `${metadata}\n\n${guidance.trim()}\n` };
}

export const RECOMMENDED_SKILLS: readonly RecommendedSkill[] = [
  skill('code-review', 'Code review',
    'Review a change for correctness, safety and clarity before it is merged, and report only findings that matter.',
    `
# Code review

Review the complete change against its intended behavior.

- Trace affected inputs, callers, state changes, and error paths.
- Look for user-visible regressions, unsafe access, lost data, and concurrency mistakes.
- Report each actionable issue with its location, triggering condition, impact, and a practical correction.
- Order findings by severity and label uncertainty; if no issue is supported by evidence, say what you checked.
`),
  skill('debug-systematically', 'Debug systematically',
    'Find the root cause of a bug with evidence before changing code, then fix it with a test that proves it.',
    `
# Debug systematically

Establish a reproducible cause before choosing a change.

1. Record the environment, input, expected result, and observed result.
2. Trace the failing value or event to the earliest incorrect boundary.
3. State a testable explanation and use a small experiment to confirm or reject it.
4. Correct the source of the defect, add a regression check, and repeat the original scenario.
5. Summarize the evidence and any case that remains unexplained.
`),
  skill('test-first-bugfix', 'Test-first bug fix',
    'Fix a bug by first writing a test that reproduces it, then making the smallest change that turns it green.',
    `
# Test-first bug fix

Turn the reported failure into an executable example.

1. Exercise the public boundary with the smallest input that exposes the defect.
2. Run the new check and confirm it fails because of the reported behavior.
3. Make a focused correction and confirm the same check now passes.
4. Add nearby cases for empty, repeated, invalid, or concurrent input when they affect the behavior.
5. Run the related suite and report exactly which checks completed.
`),
  skill('commit-and-pr', 'Commit messages and PR descriptions',
    'Write clear commit messages and pull request descriptions that explain what changed and why.',
    `
# Commit and pull request writing

Inspect the final diff before describing it.

- Use a short subject that names the outcome, then explain the reason in the body.
- Describe user-visible behavior, important implementation choices, and migration needs.
- List validation that actually ran and identify known gaps without implying they passed.
- Keep unrelated changes out of the summary and avoid claims the diff cannot support.
`),
  skill('explore-codebase', 'Explore an unfamiliar codebase',
    'Build a quick, accurate map of an unfamiliar codebase before making changes.',
    `
# Explore a codebase

Map ownership and runtime flow before editing.

1. Find the app entry points, build scripts, tests, and major package boundaries.
2. Trace one representative request from its interface through its backend owner and persistence.
3. Identify the contracts between modules and where configuration enters the system.
4. Confirm the normal local build and test commands from the project files.
5. Return a compact map with file paths and one unresolved question, if any.
`),
  skill('research-with-sources', 'Research with sources',
    'Answer a question with current, traceable sources and a clear separation between fact and inference.',
    `
# Research with sources

Build answers from evidence that can be checked.

1. Split the question into claims that need support.
2. Prefer original documents, official references, and direct data for each claim.
3. Check publication dates and whether the source covers the exact version or place in question.
4. Cite evidence beside the claim and label conclusions that combine or interpret sources.
5. State what the sources do not establish instead of filling gaps with guesses.
`),
  skill('clear-writing', 'Clear writing',
    'Make writing easier to understand without changing what it means.',
    `
# Clear writing

Write for the reader's task and familiarity with the subject.

- Put the main point and needed action near the beginning.
- Use concrete nouns, direct verbs, and one purpose per paragraph.
- Keep technical terms when they are precise; explain them when the audience needs context.
- Preserve qualifications, quantities, and uncertainty from the source.
- Remove repetition only when it does not remove a decision or useful constraint.
`),
  skill('data-analysis', 'Data analysis',
    'Analyse a dataset carefully, show how conclusions were reached and avoid claims the data cannot support.',
    `
# Data analysis

Make the dataset and each transformation explicit.

1. Record the source, time span, units, row meaning, and known collection limits.
2. Check missing values, duplicates, ranges, and category definitions before comparing results.
3. Use calculations that can be reproduced from the supplied data and show the key formula or grouping.
4. Separate observed differences from causes that the data cannot prove.
5. Present the clearest useful result and state the assumptions that affect it.
`),
  skill('security-review', 'Security review',
    'Assess a change for exploitable trust-boundary failures and explain concrete risks with practical fixes.',
    `
# Security review

Follow untrusted data to the authority or sensitive resource it can reach.

- Inspect identity checks, permissions, input validation, path and command handling, and secret exposure.
- Consider hostile values, replay, race conditions, and failures at external boundaries.
- Describe a realistic path from attacker control to impact before calling something a vulnerability.
- Prioritize confirmed risks and give a correction that preserves the intended access model.
- Report the limits of the review when runtime or deployment evidence is unavailable.
`),
  skill('write-documentation', 'Write documentation',
    'Create practical documentation that helps its intended reader complete a real task.',
    `
# Write documentation

Start from the task a reader needs to finish.

1. Name the audience, prerequisites, supported environment, and expected result.
2. Put steps in the order the reader will perform them and include complete commands or examples.
3. Explain important choices, permissions, and data handling where they affect the task.
4. Add a recovery path for likely failures and link to the owning reference.
5. Check every instruction against the current product behavior before publishing it.
`),
  skill('refactor-safely', 'Refactor safely',
    'Improve structure while keeping public behaviour and data intact.',
    `
# Refactor safely

Make structure easier to change without moving the behavior contract.

1. List the public inputs, outputs, persisted data, and important side effects.
2. Find the callers and tests that protect those promises.
3. Move one cohesive responsibility at a time behind a small, explicit boundary.
4. Keep compatibility at the owning boundary or migrate every consumer in the same change.
5. Compare behavior before and after, then record any intentional contract change separately.
`),
  skill('performance-investigation', 'Performance investigation',
    'Measure a performance problem, locate its cause and verify that a change improves the right workload.',
    `
# Performance investigation

Use measurements to choose the work.

1. Define the affected operation, workload, environment, and user-visible delay.
2. Capture a repeatable baseline and separate startup, I/O, CPU, and memory costs.
3. Profile representative runs and identify the largest verified contributor.
4. Change one cause, then repeat the same measurement under the same conditions.
5. Check correctness and resource use as well as elapsed time; document noisy results.
`),
  skill('upgrade-dependencies', 'Upgrade dependencies',
    'Upgrade dependencies carefully, accounting for security, compatibility and release notes.',
    `
# Upgrade dependencies

Evaluate the package and the application together.

1. Record the current and intended versions and the reason for the upgrade.
2. Read the package's release notes, support policy, and license for the selected version.
3. Apply required source and lockfile changes without mixing unrelated upgrades.
4. Run the package's focused checks and the application's build, type checks, and related tests.
5. Summarize compatibility changes, new notices, and any platform that still needs validation.
`),
  skill('accessibility-review', 'Accessibility review',
    'Check a web page or app screen for accessibility problems: keyboard use, labels, contrast, structure and screen readers.',
    `
# Accessibility review

Check the complete interaction using keyboard and assistive-technology semantics.

- Verify meaningful names, labels, heading order, landmarks, and image alternatives.
- Operate each control by keyboard and confirm visible focus, sensible order, and return focus after dialogs.
- Inspect contrast, zoom, reduced motion, validation messages, and dynamic status announcements.
- Describe each issue by affected element, barrier, and a testable correction.
`),
  skill('sql-queries', 'SQL queries',
    'Write, review or optimise SQL queries correctly and safely, with parameters, clear joins and a check of the results.',
    `
# SQL queries

Derive the query from the schema and the desired result.

1. Confirm the database dialect, tables, keys, null rules, and expected row grain.
2. Bind external values as parameters and make joins and selected columns explicit.
3. Check duplicates, unmatched rows, ordering, and time-zone assumptions.
4. Use an execution plan and representative data when investigating speed.
5. Preview affected rows before writes and use a transaction when the operation needs rollback.
`),
  skill('summarize-documents', 'Summarize documents',
    'Summarise long documents, threads or transcripts accurately: key points, decisions, open questions and action items.',
    `
# Summarize documents

Keep the summary faithful to the material provided.

- Lead with the subject and the most consequential conclusion.
- Separate evidence, decisions, assigned actions, and unanswered questions.
- Preserve names, dates, quantities, and qualifications that affect interpretation.
- Mark disagreement and uncertainty instead of resolving them by assumption.
- Include section or timestamp references when the reader may need to verify details.
`),
  skill('translate-faithfully', 'Translate faithfully',
    'Translate text accurately and naturally, keeping meaning, tone, formatting and terminology consistent.',
    `
# Translate faithfully

Carry the source's intent into the language and setting of its readers.

1. Identify the audience, locale, formality, and purpose before choosing phrasing.
2. Preserve names, numbers, placeholders, links, markup, and code exactly where required.
3. Follow the supplied glossary and use one term consistently for each concept.
4. Keep tone and emphasis while avoiding word-for-word phrasing that obscures meaning.
5. Flag ambiguous source text for resolution rather than silently inventing an interpretation.
`),
  skill('plan-a-project', 'Plan a project',
    'Turn a goal into a clear, realistic plan: scope, milestones, tasks, risks and a first step that can start today.',
    `
# Plan a project

Turn the requested outcome into work that can be checked.

1. Describe the outcome and observable acceptance conditions.
2. Set boundaries, assumptions, dependencies, and the people or systems involved.
3. Order milestones by dependency and uncertainty, then break them into reviewable tasks.
4. Pair material risks with an owner, signal, and response.
5. Identify the first action, the evidence of completion, and any decision that could change the plan.
`)
];
