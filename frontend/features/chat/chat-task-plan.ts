import type { TaskProgress } from '../../../contracts/automation/task-progress.js';
import type { SessionSummary } from '../../../contracts/session.js';
import { $, el, run, toast } from '../../shared/dom.js';
import { currentLanguage, t, ui } from '../../shared/i18n.js';

export interface ChatTaskPlanRuntime {
  draftKey: () => string;
  selectedId: string | null;
  selectedProjectId: string | null;
  sessions: SessionSummary[];
  authoredComposerText: () => string;
  inputDraftFor: (key: string) => string;
  forgetInputDraft: (key: string) => void;
  replaceComposerDraft: () => void;
  restoreSkills: () => void | undefined;
  localizedGoalError: typeof import('./chat-goal-progress.js').localizedGoalError;
  dockAction: (label: string | (() => string), symbol: string, click: (event: MouseEvent) => void) => HTMLButtonElement;
  paintTaskActions: () => void;
  paintDeliveryControls: () => void;
  sendComposer: (delivery?: 'finish', plan?: string[], planObjective?: string, controlAction?: boolean) => Promise<boolean | void>;
  refreshInputQueue: () => Promise<void>;
}

type Runtime = ChatTaskPlanRuntime;

export type TaskPlanDraft = {
  text: string;
  requestId: string | null;
  stages: string[] | null;
  sending: boolean;
  progress: TaskProgress | null;
  error: string | null;
};

// Owns task-plan drafts, planning requests, editable stages, and queue admission.
export function createChatTaskPlan(runtime: Runtime) {
  const api = window.api;

  // Planning belongs to its draft key. Completed stages own their captured objective independently of composer edits; existing sessions hand them to the durable queue.
  const taskPlans = new Map<string, TaskPlanDraft>();
  function currentPreparedPlan():
    (TaskPlanDraft & { stages: string[] }) | null {
    const plan = taskPlans.get(runtime.draftKey());
    return plan?.stages ? (plan as TaskPlanDraft & { stages: string[] }) : null;
  }
  function cancelTaskPlan(key = runtime.draftKey()): void {
    const plan = taskPlans.get(key);
    taskPlans.delete(key);
    if (plan?.requestId) void api.cancelTaskRequest?.(plan.requestId);
    if (runtime.draftKey() === key) paintTaskPlan();
  }
  function paintTaskPlan(): void {
    const plan = taskPlans.get(runtime.draftKey());
    const preview = $('taskPlanPreview');
    preview.replaceChildren();
    preview.hidden = !plan || (!plan.requestId && !plan.stages && !plan.error);
    ui($<HTMLTextAreaElement>('chatInput'), 'placeholder', () =>
      plan && !plan.text
        ? t('Describe the task to turn into a plan…')
        : t('Ask anything…'),
    );
    if (plan?.stages) paintPreparedPlan();
    else if (plan?.error) {
      const failure = plan.error;
      const error = el('div', 'muted', () =>
        failure === 'invalid_goal_decision_json'
          ? t('The planner response could not be read.')
          : runtime.localizedGoalError(failure),
      );
      error.title = plan.error;
      preview.append(
        error,
        el('div', 'muted', () => t('Send again to retry, or cancel the plan.')),
      );
    } else if (plan?.requestId) {
      const progress = plan.progress;
      const label = () =>
        !progress
          ? t('Creating plan…')
          : progress.phase === 'retrying'
            ? t('Provider busy · retry {0}{1}', [
                progress.attempt ?? '',
                progress.retryAt
                  ? t(' at {0}', [
                      new Date(progress.retryAt).toLocaleTimeString(
                        currentLanguage(),
                      ),
                    ])
                  : '',
              ])
            : progress.phase === 'cancelled'
              ? t('Plan cancelled')
              : progress.phase === 'preparing'
                ? t('Preparing plan…')
                : progress.phase === 'ready'
                  ? t('Plan ready')
                  : progress.phase === 'failed'
                    ? t('Plan failed')
                    : t('Writing plan…');
      preview.append(el('span', 'muted', label));
      if (progress?.text || progress?.error)
        preview.append(
          el(
            'pre',
            'task-progress-text',
            progress.error
              ? () => runtime.localizedGoalError(progress.error!)
              : progress.text,
          ),
        );
    }
    runtime.paintTaskActions();
    runtime.paintDeliveryControls();
  }
  async function createTaskPlan(backend: 'api' | 'web'): Promise<void> {
    const input = $<HTMLTextAreaElement>('chatInput'),
      text = runtime.authoredComposerText().trim();
    const key = runtime.draftKey();
    cancelTaskPlan(key);
    const sessionId = runtime.selectedId,
      projectId = runtime.selectedId
        ? (runtime.sessions.find((row) => row.id === runtime.selectedId)
            ?.projectId ?? null)
        : runtime.selectedProjectId;
    const requestId = text ? crypto.randomUUID() : null;
    const plan: TaskPlanDraft = {
      text,
      requestId,
      stages: null,
      sending: false,
      progress: null,
      error: null,
    };
    taskPlans.set(key, plan);
    paintTaskPlan();
    if (!requestId) {
      input.focus();
      return;
    }
    const current = () => taskPlans.get(key) === plan;
    const unsubscribe = api.onTaskProgress?.((progress) => {
      if (progress.requestId !== requestId || !current()) return;
      plan.progress = progress;
      if (runtime.draftKey() === key) paintTaskPlan();
    });
    try {
      const result = await api.draftTaskPlan(text, backend, requestId);
      if (!current()) return;
      const draft =
        runtime.draftKey() === key
          ? runtime.authoredComposerText()
          : (runtime.inputDraftFor(key) ?? '');
      if (draft.trim() !== text) {
        cancelTaskPlan(key);
        return;
      }
      if (result.ok) {
        plan.stages = result.data;
        plan.requestId = null;
        // The accepted result now owns the captured request. Retire only its unchanged source draft, before queue admission can yield to new typing.
        runtime.forgetInputDraft(key);
        if (runtime.draftKey() === key) {
          runtime.replaceComposerDraft();
          input.value = '';
          runtime.restoreSkills();
        }
        if (sessionId)
          await queuePreparedPlan(
            key,
            plan as TaskPlanDraft & { stages: string[] },
            sessionId,
            projectId,
          );
      } else plan.error = result.error;
    } catch (error) {
      if (current())
        plan.error = error instanceof Error ? error.message : String(error);
    } finally {
      unsubscribe?.();
      plan.requestId = null;
      if (current() && runtime.draftKey() === key) paintTaskPlan();
    }
  }
  function paintPreparedPlan(): void {
    const plan = currentPreparedPlan();
    if (!plan) return;
    const preview = $('taskPlanPreview');
    preview.hidden = plan.sending;
    // Sending hands presentation to the outbox/queued-stage rows. Keeping the editable draft visible until the async receipt arrives paints the same plan twice. Retain its data so a rejected send can restore the editable preview in the existing finally.
    if (plan.sending) {
      preview.replaceChildren();
      return;
    }
    preview.replaceChildren(
      ...plan.stages.map((stage, index) => {
        const row = el('div', 'plan-stage');
        const heading = el('div', 'plan-stage-heading');
        const label = el('span', 'stage-number', String(index + 1));
        ui(label, 'aria-label', () => t('Stage {0}', [index + 1]));
        const text = el('span', 'queue-label', stage);
        text.title = stage;
        text.dir = 'auto';
        const field = document.createElement('textarea');
        field.dir = 'auto';
        field.value = stage;
        field.maxLength = 16000;
        field.hidden = true;
        ui(field, 'aria-label', () => t('Edit stage {0}', [index + 1]));
        const error = el('span', 'stage-error', () =>
          t('Enter text or delete this stage.'),
        );
        error.id = `planStageError-${index}`;
        error.hidden = !!stage.trim();
        const validate = () => {
          error.hidden = !!field.value.trim();
          field.setAttribute('aria-invalid', String(!error.hidden));
          runtime.paintDeliveryControls();
        };
        field.setAttribute('aria-describedby', error.id);
        field.setAttribute('aria-invalid', String(!error.hidden));
        field.oninput = () => {
          plan.stages[index] = field.value;
          text.textContent = field.value;
          text.title = field.value;
          validate();
        };
        const edit = runtime.dockAction(
          () => t('Edit stage {0}', [index + 1]),
          'i-pencil',
          () => {
            field.hidden = !field.hidden;
            edit.setAttribute('aria-expanded', String(!field.hidden));
            if (!field.hidden) field.focus();
          },
        );
        edit.setAttribute('aria-expanded', 'false');
        const remove = runtime.dockAction(
          () => t('Delete stage {0}', [index + 1]),
          'i-trash',
          () => {
            if (plan.sending) return;
            plan.stages.splice(index, 1);
            if (plan.stages.length) {
              paintPreparedPlan();
              runtime.paintDeliveryControls();
            } else cancelTaskPlan();
          },
        );
        edit.disabled = remove.disabled = field.disabled = plan.sending;
        ui(heading, 'title', () =>
          runtime.selectedId
            ? t(
                'Queued at Session finish; edit or delete this checkpoint independently.',
              )
            : index === 0
              ? t(
                  'Send includes your complete request and the full plan. Later stages are queued as verification checkpoints.',
                )
              : t(
                  'Included in the first message, then queued as a checkpoint at Session finish or after a completed answer when enabled.',
                ),
        );
        heading.append(label, text, edit, remove);
        row.append(heading, field, error);
        return row;
      }),
    );
  }
  async function sendPreparedPlan(): Promise<void> {
    const key = runtime.draftKey(),
      plan = currentPreparedPlan();
    if (!plan || plan.sending) return;
    if (runtime.selectedId) {
      await queuePreparedPlan(
        key,
        plan,
        runtime.selectedId,
        runtime.sessions.find((row) => row.id === runtime.selectedId)
          ?.projectId ?? null,
      );
      return;
    }
    const tasks = plan.stages.map((stage) => stage.trim());
    if (
      !tasks.length ||
      tasks.some((task) => !task) ||
      JSON.stringify(tasks).length > 12000
    ) {
      toast(
        t('Keep every stage nonempty and the plan below 12,000 characters.'),
      );
      return;
    }
    plan.sending = true;
    paintPreparedPlan();
    try {
      const sent = await runtime.sendComposer(undefined, tasks, plan.text);
      if (taskPlans.get(key) === plan && sent) {
        await runtime.refreshInputQueue();
        if (taskPlans.get(key) === plan) cancelTaskPlan(key);
      }
    } finally {
      if (taskPlans.get(key) === plan) {
        plan.sending = false;
        if (runtime.draftKey() === key) paintTaskPlan();
      }
    }
  }
  async function queuePreparedPlan(
    key: string,
    plan: TaskPlanDraft & { stages: string[] },
    sessionId: string,
    projectId: string | null,
  ): Promise<void> {
    if (plan.sending) return;
    const stages = plan.stages.map((stage) => stage.trim());
    if (
      !stages.length ||
      stages.some((stage) => !stage) ||
      JSON.stringify(stages).length > 12000
    ) {
      toast(
        t('Keep every stage nonempty and the plan below 12,000 characters.'),
      );
      return;
    }
    plan.sending = true;
    if (runtime.draftKey() === key) paintTaskPlan();
    try {
      const result = await run(
        api.sendInput({
          id: crypto.randomUUID(),
          sessionId,
          projectId,
          text: stages[0]!,
          objective: plan.text,
          authoredSource: 'objective',
          stages: stages.slice(1),
          mode: 'finish',
          dueAt: Date.now(),
          model: null,
          reasoningEffort: null,
        }),
      );
      if (result) {
        // The result already retired its source prompt. Admission leaves any newer composer draft and attachments alone; the durable queue owns the stages.
        if (taskPlans.get(key) === plan) cancelTaskPlan(key);
        await runtime.refreshInputQueue();
      }
    } finally {
      plan.sending = false;
      if (taskPlans.get(key) === plan && runtime.draftKey() === key)
        paintTaskPlan();
    }
  }

  function getPlan(key: string): TaskPlanDraft | null {
    return taskPlans.get(key) ?? null;
  }

  function hasPlan(key: string): boolean {
    return taskPlans.has(key);
  }

  function setPlan(key: string, plan: TaskPlanDraft): void {
    taskPlans.set(key, plan);
  }

  return {
    currentPreparedPlan,
    cancelTaskPlan,
    paintTaskPlan,
    createTaskPlan,
    paintPreparedPlan,
    sendPreparedPlan,
    getPlan,
    hasPlan,
    setPlan,
  };
}
