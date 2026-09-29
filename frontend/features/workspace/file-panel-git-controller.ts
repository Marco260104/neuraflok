import type { LocalProject } from "../../../contracts/workspace/projects.js";
import type {
  ProjectGitChange,
  ProjectGitSnapshot,
  ProjectGitDiff,
} from "../../../contracts/workspace/project-git.js";
import { run } from "../../shared/dom.js";
import { t } from "../../shared/i18n.js";
import { renderProjectGitChanges } from "./file-panel-git-list.js";
import type { FilePanelMode } from "./file-panel-review.js";

export interface FilePanelGitControllerRuntime {
  project(): LocalProject | null;
  mode(): FilePanelMode;
  setMode(mode: FilePanelMode): void;
  render(): void;
  renderTree(): void;
  destroyDiffViewer(): void;
  reviewOnly: boolean;
  pane: HTMLElement;
  backToFiles: HTMLButtonElement;
  changes: HTMLButtonElement;
  changesBadge: HTMLElement;
  changesList: HTMLElement;
}

export function createFilePanelGitController(runtime: FilePanelGitControllerRuntime) {
  let snapshot: ProjectGitSnapshot | null = null;
  let selectedBaseRef: string | null = null;
  let loading = false;
  let generation = 0;
  let diffGeneration = 0;
  let diffPath: string | null = null;
  let diffValue: ProjectGitDiff | null = null;
  let reconcileTimer: number | null = null;

  function updateChangesButton(): void {
    const count = snapshot?.state === "ready" ? snapshot.changes.length : 0;
    runtime.changesBadge.textContent = String(count);
    runtime.changesBadge.hidden = count === 0;
    runtime.changes.classList.toggle("is-active", runtime.mode() === "changes");
    runtime.changes.setAttribute("aria-pressed", String(runtime.mode() === "changes"));
    const label = count > 0 ? t("Changes ({0})", [count]) : t("Changes");
    runtime.changes.title = label;
    runtime.changes.setAttribute("aria-label", label);
  }

  function renderChangesList(): void {
    renderProjectGitChanges({
      changesList: runtime.changesList,
      project: runtime.project(),
      gitLoading: loading,
      snapshot,
      diffPath,
      openGitDiff,
    });
  }

  function closeDiff(): void {
    diffGeneration++;
    diffPath = null;
    diffValue = null;
    runtime.destroyDiffViewer();
    runtime.render();
  }

  async function openGitDiff(change: ProjectGitChange): Promise<void> {
    const current = runtime.project();
    if (!current || runtime.mode() !== "changes") return;
    const entering = diffPath !== change.path;
    const token = ++diffGeneration;
    diffPath = change.path;
    diffValue = null;
    runtime.destroyDiffViewer();
    runtime.render();
    if (entering) runtime.backToFiles.focus();
    const baseRef = selectedBaseRef;
    const expectedRevision = baseRef ? snapshot?.revision : undefined;
    const value = await run(
      window.api.getProjectGitDiff(
        current.id,
        change.path,
        baseRef ?? undefined,
        expectedRevision,
      ),
    );
    if (!value) {
      if (
        token === diffGeneration &&
        runtime.project()?.id === current.id &&
        diffPath === change.path
      )
        closeDiff();
      return;
    }
    if (
      token !== diffGeneration ||
      runtime.project()?.id !== current.id ||
      runtime.mode() !== "changes" ||
      diffPath !== change.path ||
      selectedBaseRef !== baseRef
    )
      return;
    diffValue = value;
    runtime.render();
  }

  async function reconcile(forceDiff = false): Promise<void> {
    const current = runtime.project();
    if (!current) {
      snapshot = null;
      loading = false;
      updateChangesButton();
      runtime.renderTree();
      renderChangesList();
      return;
    }
    const token = ++generation;
    loading = true;
    if (runtime.mode() === "changes") renderChangesList();
    const baseRef = selectedBaseRef;
    const nextSnapshot = await run(
      window.api.getProjectGitSnapshot(current.id, baseRef ?? undefined),
    );
    if (
      token !== generation ||
      runtime.project()?.id !== current.id ||
      selectedBaseRef !== baseRef
    )
      return;
    if (!nextSnapshot) {
      loading = false;
      snapshot = {
        projectId: current.id,
        state: "unavailable",
        changes: [],
        truncated: false,
        revision: "",
      };
      if (diffPath && runtime.mode() !== "review") closeDiff();
      else runtime.render();
      return;
    }
    const previousRevision = snapshot?.revision;
    snapshot = nextSnapshot;
    loading = false;
    const selected = diffPath && nextSnapshot.state === "ready"
      ? nextSnapshot.changes.find((change) => change.path === diffPath)
      : undefined;
    if (runtime.mode() !== "review") {
      if (diffPath && !selected) {
        closeDiff();
        return;
      }
      if (selected && (forceDiff || previousRevision !== nextSnapshot.revision)) {
        void openGitDiff(selected);
        return;
      }
    }
    runtime.render();
  }

  function scheduleReconcile(): void {
    if (reconcileTimer !== null) window.clearTimeout(reconcileTimer);
    // Use a renderer-owned debounce so closed documents do not retain Node timers.
    reconcileTimer = window.setTimeout(() => {
      reconcileTimer = null;
      if (!runtime.pane.isConnected || runtime.pane.hidden) return;
      void reconcile(Boolean(diffPath));
    }, 120);
  }

  function showFiles(): void {
    if (runtime.reviewOnly || runtime.mode() !== "changes") return;
    runtime.setMode("files");
    diffGeneration++;
    diffPath = null;
    diffValue = null;
    runtime.destroyDiffViewer();
    runtime.render();
  }

  function restoreDiffAfterReview(): boolean {
    if (!diffPath) return false;
    const selected = snapshot?.state === "ready"
      ? snapshot.changes.find((change) => change.path === diffPath)
      : undefined;
    if (selected) {
      void openGitDiff(selected);
      return true;
    }
    diffPath = null;
    diffValue = null;
    return false;
  }

  function selectBaseRef(ref: string | null): void {
    selectedBaseRef = ref;
    diffGeneration++;
    diffPath = null;
    diffValue = null;
    snapshot = null;
    runtime.destroyDiffViewer();
    runtime.render();
    void reconcile();
  }

  function cancelScheduledReconcile(): void {
    if (reconcileTimer !== null) window.clearTimeout(reconcileTimer);
    reconcileTimer = null;
  }

  function resetForProjectChange(): void {
    generation++;
    diffGeneration++;
    cancelScheduledReconcile();
    snapshot = null;
    loading = false;
    diffPath = null;
    diffValue = null;
    selectedBaseRef = null;
  }

  return {
    snapshot: () => snapshot,
    loading: () => loading,
    selectedBaseRef: () => selectedBaseRef,
    diffPath: () => diffPath,
    diffValue: () => diffValue,
    updateChangesButton,
    renderChangesList,
    closeDiff,
    openGitDiff,
    reconcile,
    scheduleReconcile,
    showFiles,
    restoreDiffAfterReview,
    selectBaseRef,
    cancelScheduledReconcile,
    resetForProjectChange,
  };
}
