import type { LocalProject } from "../../../contracts/workspace/projects.js";
import type { ToolEditReview } from "../../../contracts/session.js";
import { run, toast } from "../../shared/dom.js";
import { t } from "../../shared/i18n.js";

export type FilePanelMode = "files" | "changes" | "review";

export interface FilePanelReviewSource {
  sessionId: string;
  callId: string;
  indices: number[];
  cursor: number;
}

export interface FilePanelReviewRuntime {
  project(): LocalProject | null;
  generation(): number;
  mode(): FilePanelMode;
  setMode(mode: FilePanelMode): void;
  editingPath(): string | null;
  leaveEditorIfNeeded(): Promise<boolean>;
  destroyCodeViewer(): void;
  destroyPdfViewer(): void;
  destroyDiffViewer(): void;
  restoreChangesDiff(): boolean;
  show(reconcile?: boolean): Promise<void>;
  render(): void;
  pane: HTMLElement;
  body: HTMLElement;
  backToFiles: HTMLButtonElement;
}

export function createFilePanelReview(runtime: FilePanelReviewRuntime) {
  let returnMode: "files" | "changes" = "files";
  let source: FilePanelReviewSource | null = null;
  let value: ToolEditReview | null = null;
  let generation = 0;

  function leaveReview(): void {
    if (runtime.mode() !== "review") return;
    generation++;
    source = null;
    value = null;
    runtime.setMode(returnMode);
    runtime.destroyDiffViewer();
    if (runtime.mode() === "changes" && runtime.restoreChangesDiff()) return;
    runtime.render();
  }

  async function selectReview(cursor: number): Promise<void> {
    const selectedSource = source;
    const current = runtime.project();
    if (
      !selectedSource ||
      !current ||
      cursor < 0 ||
      cursor >= selectedSource.indices.length
    )
      return;
    const token = ++generation;
    selectedSource.cursor = cursor;
    value = null;
    runtime.destroyDiffViewer();
    runtime.render();
    const nextValue = await run(
      window.api.getToolEditReview(
        selectedSource.sessionId,
        selectedSource.callId,
        selectedSource.indices[cursor]!,
      ),
    );
    if (
      token !== generation ||
      runtime.project()?.id !== current.id ||
      runtime.mode() !== "review" ||
      source !== selectedSource
    )
      return;
    if (!nextValue) {
      leaveReview();
      toast(t("Recorded edit is unavailable."));
      return;
    }
    value = nextValue;
    runtime.render();
  }

  async function openReview(
    projectId: string,
    sessionId: string,
    callId: string,
    indices: number[],
  ): Promise<boolean> {
    const projectGeneration = runtime.generation();
    if (
      runtime.project()?.id !== projectId ||
      !indices.length ||
      indices.length > 32 ||
      indices.some(
        (index) =>
          !Number.isSafeInteger(index) || index < 0 || index >= 64,
      )
    )
      return false;
    if (
      runtime.editingPath() &&
      !(await runtime.leaveEditorIfNeeded())
    )
      return false;
    if (
      runtime.project()?.id !== projectId ||
      runtime.generation() !== projectGeneration
    )
      return false;
    generation++;
    returnMode = runtime.mode() === "changes" ? "changes" : "files";
    source = { sessionId, callId, indices, cursor: 0 };
    value = null;
    runtime.setMode("review");
    runtime.body.classList.remove("is-reading");
    runtime.destroyCodeViewer();
    runtime.destroyPdfViewer();
    runtime.destroyDiffViewer();
    if (runtime.pane.hidden) await runtime.show(false);
    else runtime.render();
    if (runtime.project()?.id !== projectId || runtime.mode() !== "review")
      return false;
    await selectReview(0);
    if (runtime.project()?.id === projectId && runtime.mode() === "review") {
      runtime.backToFiles.focus();
    }
    return (
      runtime.project()?.id === projectId &&
      runtime.mode() === "review" &&
      value !== null
    );
  }

  function reset(): void {
    generation++;
    source = null;
    value = null;
  }

  return {
    source: () => source,
    value: () => value,
    returnMode: () => returnMode,
    leaveReview,
    selectReview,
    openReview,
    reset,
  };
}
