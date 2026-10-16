import type { ActivitySummary, FileChange } from '../../../../contracts/session.js';
import type { SummaryInput } from './summary-types.js';
const UNDONE: Record<string, string> = {
  Edited: 'edit',
  Applied: 'apply',
  Rewrote: 'rewrite',
  Appended: 'append',
  Created: 'create',
  Saved: 'save',
  Interrupted: 'interrupt',
  Filled: 'fill',
  Wrote: 'write',
  Moved: 'move',
  Deleted: 'delete',
  Read: 'read',
  Viewed: 'view',
  Inspected: 'inspect',
  Listed: 'list',
  Searched: 'search',
  Checked: 'check',
  Ran: 'run',
  Launched: 'launch',
  Started: 'start',
  Stopped: 'stop',
  Opened: 'open',
  Looked: 'look',
  Waited: 'wait',
  Clicked: 'click',
  'Double-clicked': 'double-click',
  Dragged: 'drag',
  Scrolled: 'scroll',
  Typed: 'type',
  Pressed: 'press',
  Focused: 'focus',
  Acted: 'act',
  Copied: 'copy',
  Staged: 'stage',
  Replaced: 'replace',
  Loaded: 'load',
  Messaged: 'message',
  Reported: 'report',
  Requested: 'request'
};

const ONGOING: Record<string, string> = {
  Edited: 'Editing', Applied: 'Applying', Rewrote: 'Rewriting', Appended: 'Appending', Created: 'Creating',
  Saved: 'Saving', Interrupted: 'Interrupting', Filled: 'Filling', Wrote: 'Writing', Moved: 'Moving',
  Deleted: 'Deleting', Read: 'Reading', Viewed: 'Viewing', Inspected: 'Inspecting', Listed: 'Listing',
  Searched: 'Searching', Checked: 'Checking', Ran: 'Running', Launched: 'Launching', Started: 'Starting',
  Stopped: 'Stopping', Opened: 'Opening', Looked: 'Looking', Waited: 'Waiting', Clicked: 'Clicking',
  'Double-clicked': 'Double-clicking', Dragged: 'Dragging', Scrolled: 'Scrolling', Typed: 'Typing',
  Pressed: 'Pressing', Focused: 'Focusing', Acted: 'Acting', Replaced: 'Replacing', Loaded: 'Loading',
  Messaged: 'Messaging', Reported: 'Reporting', Requested: 'Requesting', Updated: 'Updating', Cleared: 'Clearing',
  Copied: 'Copying', Staged: 'Staging'
};

const UNDONE_WHOLE: Record<string, string> = {};
const ALREADY_NEGATIVE = /^(Could not|Refused|Failed|Command failed)\b/;

function undoTitle(title: string, refused: boolean): string {
  if (ALREADY_NEGATIVE.test(title)) return title;
  const lead = refused ? 'Refused to' : 'Could not';
  const whole = UNDONE_WHOLE[title];
  if (whole) return `${lead} ${whole}`;
  const space = title.indexOf(' ');
  const first = space === -1 ? title : title.slice(0, space);
  const verb = UNDONE[first];
  if (!verb) return `${refused ? 'Refused' : 'Failed'}: ${title}`;
  return `${lead} ${verb}${space === -1 ? '' : title.slice(space)}`;
}

export function summarizeOutcome(input: SummaryInput, summary: ActivitySummary, changes: readonly FileChange[]): ActivitySummary {
  if (input.outcome === 'ok' || input.outcome === 'process_exit_nonzero') return summary;
  const refused = input.outcome === 'tool_rejected';
  const head = (input.resultHead ?? '').trim();
  const patchMismatch = refused && input.tool === 'apply_patch' && changes.length === 0 &&
    /^apply_patch verification failed: Failed to find (?:expected lines in |context(?: in | '))/.test(head);
  const failed: ActivitySummary = {
    ...summary,
    tone: input.outcome === 'tool_internal_error' ? 'bad' : 'warn',
    title: patchMismatch ? 'Patch didn’t match' :
      input.outcome === 'tool_execution_error' ? `Tool ${input.tool} failed` : undoTitle(summary.title, refused)
  };
  if (patchMismatch) {
    failed.metric = 'not applied';
  } else if (refused) {
    failed.metric = 'refused';
  } else if (!failed.metric || !failed.metric.startsWith('✕')) {
    failed.metric = '✕ failed';
  }
  if (head && !failed.detail) failed.detail = head.slice(0, 120);
  return failed;
}

export function ongoingTitle(title: string): string | null {
  const space = title.indexOf(' ');
  const verb = ONGOING[space === -1 ? title : title.slice(0, space)];
  return verb ? `${verb}${space === -1 ? '' : title.slice(space)}` : null;
}
