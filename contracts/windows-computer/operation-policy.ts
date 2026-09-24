type OperationPolicy = {
  access: 'read' | 'input';
  requiresObservation?: true;
};

const OPERATIONS = {
  list_windows: { access: 'read' },
  get_window: { access: 'read' },
  list_apps: { access: 'read' },
  get_window_state: { access: 'read' },
  launch_app: { access: 'input' },
  click: { access: 'input', requiresObservation: true },
  press_key: { access: 'input' },
  type_text: { access: 'input' },
  scroll: { access: 'input', requiresObservation: true },
  set_value: { access: 'input', requiresObservation: true },
  drag: { access: 'input', requiresObservation: true },
  perform_secondary_action: { access: 'input', requiresObservation: true },
  activate_window: { access: 'input' }
} as const satisfies Record<string, OperationPolicy>;

export type WindowsComputerMethod = keyof typeof OPERATIONS;

const OPERATION_NAMES = Object.freeze(Object.keys(OPERATIONS) as WindowsComputerMethod[]);

function namesForAccess(access: OperationPolicy['access']): readonly WindowsComputerMethod[] {
  return Object.freeze(OPERATION_NAMES.filter(method => OPERATIONS[method].access === access));
}

export const WINDOWS_COMPUTER_METHODS = OPERATION_NAMES;
export const WINDOWS_COMPUTER_READ_METHODS = namesForAccess('read');
export const WINDOWS_COMPUTER_INPUT_METHODS = namesForAccess('input');
export const WINDOWS_COMPUTER_STATE_INPUT_METHODS = Object.freeze(
  OPERATION_NAMES.filter(method => 'requiresObservation' in OPERATIONS[method])
);
