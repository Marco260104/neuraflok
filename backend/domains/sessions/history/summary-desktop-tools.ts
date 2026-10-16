import type { ActivitySummary } from '../../../../contracts/session.js';
import type { SummaryInput } from './summary-types.js';
import { arr, plural, record, str } from './summary-format.js';

export function summarizeDesktopTool(input: SummaryInput, args: Record<string, unknown>): ActivitySummary | null {
  const evidence = input.evidence;
  switch (input.tool) {
    case 'observe': {
      const what = str(args['what']) ?? (str(args['wait_for']) ? 'window' : 'active');
      if (str(args['wait_for'])) return { kind: 'screen', tone: 'neutral', title: `Waited for ${str(args['wait_for'])}` };
      if (what === 'windows') {
        return {
          kind: 'screen',
          tone: 'neutral',
          title: 'Listed open windows',
          ...(evidence.count !== null ? { detail: plural(evidence.count, 'window') } : {})
        };
      }
      if (what === 'ui') {
        return {
          kind: 'screen',
          tone: 'neutral',
          title: `Looked for ${JSON.stringify((str(args['match']) ?? '').slice(0, 40))}`,
          ...(evidence.count !== null ? { detail: plural(evidence.count, 'match', 'matches') } : {})
        };
      }
      return {
        kind: 'screen',
        tone: 'neutral',
        title: 'Looked at the screen',
        ...(evidence.count !== null ? { detail: plural(evidence.count, 'control') } : {})
      };
    }
    case 'list_windows': return { kind: 'screen', tone: 'neutral', title: 'Listed open windows' };
    case 'get_window': return { kind: 'screen', tone: 'neutral', title: 'Inspected a window' };
    case 'list_apps': return { kind: 'screen', tone: 'neutral', title: 'Listed installed apps' };
    case 'get_window_state': return { kind: 'screen', tone: 'neutral', title: 'Inspected window state' };
    case 'launch_app': return { kind: 'input', tone: 'neutral', title: 'Requested an app launch' };
    case 'click': return { kind: 'input', tone: 'neutral', title: 'Clicked in a window' };
    case 'press_key': return { kind: 'input', tone: 'neutral', title: 'Pressed keys in a window' };
    case 'type_text': return { kind: 'input', tone: 'neutral', title: 'Typed in a window' };
    case 'scroll': return { kind: 'input', tone: 'neutral', title: 'Scrolled in a window' };
    case 'set_value': return { kind: 'input', tone: 'neutral', title: 'Replaced a field value' };
    case 'drag': return { kind: 'input', tone: 'neutral', title: 'Dragged in a window' };
    case 'perform_secondary_action': return { kind: 'input', tone: 'neutral', title: 'Acted on a window control' };
    case 'activate_window': return { kind: 'input', tone: 'neutral', title: 'Focused a window' };
    case 'read_clipboard': return { kind: 'clipboard', tone: 'neutral', title: 'Read the clipboard' };
    case 'write_clipboard': return { kind: 'clipboard', tone: 'neutral', title: 'Replaced the clipboard text' };
    case 'computer': {
      const actions = arr(args['actions']).map(action => str(record(action)['type']) ?? '?');
      const kinds = [...new Set(actions)];
      const label: Record<string, string> = {
        click: 'Clicked',
        click_ref: 'Clicked',
        set_value: 'Filled in a field',
        double_click: 'Double-clicked',
        move: 'Moved the pointer',
        drag: 'Dragged',
        scroll: 'Scrolled',
        type: 'Typed',
        keypress: 'Pressed keys',
        focus: 'Focused a window',
        wait: 'Waited',
        read_clipboard: 'Read the clipboard',
        write_clipboard: 'Replaced the clipboard text'
      };
      const title = kinds.length === 1
        ? (label[kinds[0]!] ?? 'Acted on the desktop')
        : `${label[kinds[0]!] ?? 'Acted'} and ${kinds.length - 1} more`;
      return {
        kind: kinds.every(kind => kind.endsWith('_clipboard')) ? 'clipboard' : 'input',
        tone: 'neutral',
        title,
        ...(actions.length > 1 ? { detail: plural(actions.length, 'action') } : {})
      };
    }
    default:
      return null;
  }
}
