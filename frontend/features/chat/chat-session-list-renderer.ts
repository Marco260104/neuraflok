import type { SessionSummary } from "../../../contracts/session.js";
import {
  projectSidebarSortEntries,
  renderProjectSidebar,
  type ProjectSidebarRows,
} from "./chat-project-sidebar.js";
import type { ChatSessionListRuntime } from "./chat-session-list.js";

export function createChatSessionListRenderer(
  runtime: ChatSessionListRuntime,
  scheduleToolActivityExpiry: () => void,
) {
  function paintSessions(): void {
    // Keep the pointer's elected rows alive while asynchronous activity snapshots arrive.
    if (runtime.state.sidebarOrder?.interacting) return;
    // Nor replace the name field mid-word: an input method's composition (Chinese, Japanese, Korean) lives in that exact node. The edit's end repaints with everything that changed.
    if (
      runtime.state.renaming &&
      (document.activeElement as HTMLElement | null)?.classList.contains(
        "sess-rename",
      )
    )
      return;
    const projectList = runtime.ui.$("projectList"),
      chatList = runtime.ui.$("chatList");
    // Activity replaces sidebar nodes. Keep an actively focused project control (its disclosure or one of its buttons) attached to its exact project, without moving focus from the composer or settings. A keyboard user tabbing to a project's buttons lost focus to the page on the next repaint, and so did the color button after a pick.
    const focused = document.activeElement;
    const focusedControl =
      focused instanceof HTMLElement && projectList.contains(focused)
        ? [
            ".project-heading",
            ".project-new",
            ".project-menu",
            ".project-show-more",
          ].find((selector) => focused.matches(selector))
        : undefined;
    const focusedProject = focusedControl
      ? (focused as HTMLElement).closest<HTMLElement>(".project-group")?.dataset
          .projectId
      : undefined;
    const children = new Map<string, SessionSummary[]>();
    const ids = new Set(runtime.state.sessions.map((entry) => entry.id));
    for (const entry of runtime.state.sessions) {
      if (entry.origin?.kind !== "worker") continue;
      const parent = entry.origin.fromSessionId;
      const key =
        parent && ids.has(parent) && parent !== entry.id
          ? parent
          : "other-workers";
      children.set(key, [...(children.get(key) ?? []), entry]);
    }
    const rows: HTMLElement[] = [];
    // A task and its expanded workers are one sidebar item for project pagination.
    const projectRows: ProjectSidebarRows = new Map();
    const diagnostics: SessionSummary[] = [];
    const group = (
      key: string,
      workers: SessionSummary[],
      parentRow?: HTMLElement,
      target = rows,
    ): void => {
      const button = runtime.ui.el("button", "worker-toggle");
      button.append(runtime.ui.disclosureChevron());
      runtime.ui.ui(button, "title", () =>
        runtime.ui.t("{0} sub-agents · {1} active", [
          workers.length,
          workers.filter(runtime.helpers.sessionWorking).length,
        ]),
      );
      runtime.ui.ui(button, "aria-label", () =>
        runtime.ui.t("{0} {1} sub-agents", [
          runtime.state.expandedWorkers.has(key)
            ? runtime.ui.t("Collapse")
            : runtime.ui.t("Expand"),
          workers.length,
        ]),
      );
      button.setAttribute("type", "button");
      button.setAttribute(
        "aria-expanded",
        String(runtime.state.expandedWorkers.has(key)),
      );
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        runtime.state.expandedWorkers.has(key)
          ? runtime.state.expandedWorkers.delete(key)
          : runtime.state.expandedWorkers.add(key);
        paintSessions();
      });
      if (parentRow) {
        parentRow.append(button);
        parentRow.title += ` · ${button.title}`;
      } else target.push(button);
      if (runtime.state.expandedWorkers.has(key)) {
        const box = runtime.ui.el("div", "worker-group");
        box.append(...workers.map(runtime.helpers.sessionRow));
        target.push(box);
      }
    };
    // Pinned chats lead their group, which retains its own manual order.
    const orderedSessions = [
      ...new Set(
        runtime.state.sessions.map(
          (entry) => runtime.helpers.projectGroup(entry.projectId) ?? "",
        ),
      ),
    ].flatMap((scope) => {
      const members = runtime.state.sessions.filter(
        (entry) =>
          (runtime.helpers.projectGroup(entry.projectId) ?? "") === scope,
      );
      const group = (pinned: boolean) => {
        const rows = members.filter(
          (entry) => runtime.helpers.pinnedChat(entry) === pinned,
        );
        return runtime.state.sidebarOrder
          ? runtime.state.sidebarOrder.ordered(
              runtime.helpers.pinnedSortScope(scope, pinned),
              rows,
            )
          : rows;
      };
      return [...group(true), ...group(false)];
    });
    for (const entry of orderedSessions) {
      if (entry.origin?.kind === "worker") continue;
      if (!entry.conversationId && entry.origin?.kind !== "desktop") {
        diagnostics.push(entry);
        continue;
      }
      const projectId = runtime.helpers.projectGroup(entry.projectId);
      const target: HTMLElement[] = projectId ? [] : rows;
      const row = runtime.helpers.sessionRow(entry);
      target.push(row);
      row.dataset.sortScope = runtime.helpers.pinnedSortScope(
        projectId ?? "",
        runtime.helpers.pinnedChat(entry),
      );
      const workers = children.get(entry.id);
      if (workers) group(entry.id, workers, row, target);
      if (projectId) {
        const tasks = projectRows.get(projectId) ?? [];
        tasks.push({
          rows: target,
          selected:
            entry.id === runtime.state.selectedId ||
            workers?.some(
              (worker) => worker.id === runtime.state.selectedId,
            ) === true,
        });
        projectRows.set(projectId, tasks);
      }
    }
    const otherWorkers = children.get("other-workers") ?? [];
    if (otherWorkers.length) {
      const history = document.createElement("details");
      history.className = "session-diagnostics";
      history.open = runtime.state.expandedWorkers.has("other-workers");
      history.append(
        runtime.ui.el("summary", "", () =>
          runtime.ui.t("Sub-agent history · {0}", [otherWorkers.length]),
        ),
      );
      history.append(...otherWorkers.map(runtime.helpers.sessionRow));
      history.addEventListener("toggle", () => {
        if (history.isConnected)
          history.open
            ? runtime.state.expandedWorkers.add("other-workers")
            : runtime.state.expandedWorkers.delete("other-workers");
      });
      rows.push(history);
    }
    const projectSections = renderProjectSidebar(
      runtime,
      projectRows,
      paintSessions,
    );
    if (diagnostics.length) {
      const disclosure = document.createElement("details");
      disclosure.className = "session-diagnostics";
      disclosure.open = runtime.state.diagnosticsExpanded;
      disclosure.append(
        runtime.ui.el("summary", "", () =>
          runtime.ui.t("Unattributed activity · {0}", [diagnostics.length]),
        ),
      );
      disclosure.append(...diagnostics.map(runtime.helpers.sessionRow));
      disclosure.addEventListener("toggle", () => {
        runtime.state.diagnosticsExpanded = disclosure.open;
      });
      rows.push(disclosure);
    }
    // A new node is not :hover until the pointer moves again: the row under it would lose its hover look for a moment, and a sub-agent arrow would jump back to the menu's column and slide out again. The row under the pointer is born pointed (until the pointer leaves), keeps its tooltip, and an arrow that changed turns from where it was.
    const pointedId = [projectList, chatList]
      .map((list) => list.querySelector<HTMLElement>(".sess:hover")?.dataset.id)
      .find(Boolean);
    const arrowsBefore = new Map(
      [
        ...projectList.querySelectorAll<HTMLElement>(".sess > .worker-toggle"),
        ...chatList.querySelectorAll<HTMLElement>(".sess > .worker-toggle"),
      ].map((toggle) => [
        toggle.parentElement!.dataset.id,
        toggle.getAttribute("aria-expanded"),
      ]),
    );
    // Both scopes keep the existing sessionList drag/order owner and durable project binding.
    projectList.replaceChildren(...projectSections);
    chatList.replaceChildren(...rows);
    const pointed = pointedId
      ? [
          ...projectList.querySelectorAll<HTMLElement>(".sess"),
          ...chatList.querySelectorAll<HTMLElement>(".sess"),
        ].find((row) => row.dataset.id === pointedId)
      : undefined;
    if (pointed) {
      pointed.classList.add("is-pointed");
      pointed.addEventListener(
        "pointerleave",
        () => pointed.classList.remove("is-pointed"),
        { once: true },
      );
    }
    // The tooltip of the row still under the pointer follows the new row (its text may have changed); any other tooltip goes with its row.
    const tooltip = document.getElementById("sessionTooltip");
    if (tooltip && pointed && tooltip.dataset.for === pointedId)
      runtime.helpers.placeSessionTooltip(tooltip, pointed);
    else tooltip?.remove();
    for (const list of [projectList, chatList]) {
      for (const toggle of list.querySelectorAll<HTMLElement>(
        ".sess > .worker-toggle",
      )) {
        const before = arrowsBefore.get(toggle.parentElement!.dataset.id);
        const now = toggle.getAttribute("aria-expanded");
        if (before === undefined || before === now) continue;
        toggle
          .querySelector<SVGElement>(".disclosure-chevron")
          ?.animate?.(
            [
              { transform: `rotate(${before === "true" ? 90 : 0}deg)` },
              { transform: `rotate(${now === "true" ? 90 : 0}deg)` },
            ],
            { duration: 150, easing: "cubic-bezier(.2, .8, .2, 1)" },
          );
      }
    }
    if (focusedProject && focusedControl)
      projectSections
        .find((section) => section.dataset.projectId === focusedProject)
        ?.querySelector<HTMLElement>(focusedControl)
        ?.focus({ preventScroll: true });
    const workers = runtime.state.sessions.filter(
      (entry) =>
        entry.origin?.kind === "worker" &&
        entry.origin.fromSessionId === runtime.state.selectedId &&
        runtime.state.selectedId !== null,
    );
    runtime.state.agentPanel?.update(runtime.state.selectedId, workers);
    runtime.state.filePanel?.update(runtime.helpers.selectedLocalProject());
    runtime.state.reviewPanel?.update(runtime.helpers.selectedLocalProject());
    runtime.state.workspaceDocks?.sync();
    runtime.state.workspaceTerminal?.update(
      runtime.helpers.selectedLocalProject(),
    );
    runtime.state.rightWorkspaceTerminal?.update(
      runtime.helpers.selectedLocalProject(),
    );
    runtime.state.badgeKey = runtime.actions.badgeSignature();
    runtime.ui.$("projectsEmpty").hidden = projectSections.length > 0;
    runtime.ui.$("sessionsEmpty").hidden = rows.length > 0;

    scheduleToolActivityExpiry();
  }

  return {
    projectSortEntries: () => projectSidebarSortEntries(runtime),
    paintSessions,
  };
}
