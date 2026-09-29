const VERB = 'Reading|Read|Editing|Edited|Creating|Created|Deleting|Deleted|Moving|Moved|Listing|Listed|Searching|Searched|Checking|Checked|Viewing|Viewed|Inspecting|Inspected|Running|Ran|Starting|Started|Copying|Copied|Staging|Staged|Completed';
const SCRIPT = /^(Reading|Read|Editing|Edited|Creating|Created|Deleting|Deleted|Moving|Moved|Listing|Listed|Searching|Searched|Checking|Checked|Viewing|Viewed|Inspecting|Inspected|Running|Ran|Starting|Started|Copying|Copied|Staging|Staged) the (.+) script$/;
const FILES_IN = new RegExp(`^(${VERB}) files in (.+)$`);
const COUNTED = new RegExp(`^(${VERB}) (\\d+) (files|file|paths|path)$`);
const GIT = /^(Running|Ran|Starting|Started|Checking|Checked|Reading|Read|Staging|Staged) git(?: (.+))?$/;
const FAIL = /^(Could not|Refused to) (read|edit|apply|run|create|delete|search|list|move|copy|stage|write)(?: (.+))?$/i;
const LOCATED = new RegExp(`^(${VERB}) (.+) in (.+)$`);
const PLAIN = new RegExp(`^(${VERB}|Could not|Refused to|Command failed) (.+)$`);

/** Turn an English activity line into the active language: "Read a.ts in src" → "Vio a.ts de src". */
export function localizeActivityTitle(
  title: string,
  translate: (source: string, args?: readonly unknown[]) => string
): string {
  const exact = translate(title);
  if (exact !== title) return exact;
  const script = SCRIPT.exec(title);
  if (script) return translate(`${script[1]} the {0} script`, [script[2]]);
  const filesIn = FILES_IN.exec(title);
  if (filesIn) return translate(`${filesIn[1]} files in {0}`, [filesIn[2]]);
  const counted = COUNTED.exec(title);
  if (counted) return translate(`${counted[1]} {0} ${counted[3]}`, [counted[2]]);
  const git = GIT.exec(title);
  if (git?.[2]) return translate(`${git[1]} git {0}`, [git[2]]);
  const fail = FAIL.exec(title);
  if (fail) {
    const rest = fail[3] ?? '';
    const located = /^(.+) in (.+)$/.exec(rest);
    if (located) return translate(`${fail[1]} ${fail[2]!.toLowerCase()} {0} in {1}`, [located[1], located[2]]);
    if (rest) return translate(`${fail[1]} ${fail[2]!.toLowerCase()} {0}`, [rest]);
    return translate(`${fail[1]} ${fail[2]!.toLowerCase()}`);
  }
  const located = LOCATED.exec(title);
  if (located) return translate(`${located[1]} {0} in {1}`, [located[2], located[3]]);
  const plain = PLAIN.exec(title);
  if (plain) return translate(`${plain[1]} {0}`, [plain[2]]);
  return title;
}
