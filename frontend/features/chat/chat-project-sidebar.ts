import type { ChatSessionListRuntime } from "./chat-session-list.js";

export interface ProjectSidebarTask {
  rows: HTMLElement[];
  selected: boolean;
}

export type ProjectSidebarRows = Map<string, ProjectSidebarTask[]>;

export function projectSidebarSortEntries(
  runtime: ChatSessionListRuntime,
): Array<{ id: string; scope: string }> {
  const ids = new Set(
    runtime.state.projects
      .filter((project) => !project.ungrouped)
      .map((project) => project.id),
  );
  for (const entry of runtime.state.sessions) {
    if (
      entry.origin?.kind === "worker" ||
      (!entry.conversationId && entry.origin?.kind !== "desktop")
    )
      continue;
    const id = runtime.helpers.projectGroup(entry.projectId);
    if (id) ids.add(id);
  }
  return [...ids].map((id) => ({
    id,
    scope: runtime.constants.SIDEBAR_PROJECT_SCOPE,
  }));
}

export function renderProjectSidebar(
  runtime: ChatSessionListRuntime,
  projectRows: ProjectSidebarRows,
  paintSessions: () => void,
): HTMLElement[] {
  const projectEntries = projectSidebarSortEntries(runtime);
  const orderedProjects =
    runtime.state.sidebarOrder?.ordered(
      runtime.constants.SIDEBAR_PROJECT_SCOPE,
      projectEntries,
    ) ?? projectEntries;
  const projectSections: HTMLElement[] = [];
  for (const { id } of orderedProjects) {
    const project = runtime.state.projects.find((row) => row.id === id);
    const section = document.createElement("details");
    section.className = "project-group";
    section.dataset.projectId = id;
    if (project?.color) section.dataset.projectColor = project.color;
    section.dataset.sortId = id;
    section.dataset.sortScope = runtime.constants.SIDEBAR_PROJECT_SCOPE;
    section.open = runtime.state.expandedProjects.has(id);
    const heading = runtime.ui.el("summary", "project-heading");
    heading.dataset.sortHandle = "";
    heading.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    const label = runtime.ui.el(
      "span",
      "project-name",
      () => project?.name ?? runtime.ui.t("Unavailable project"),
    );
    runtime.ui.ui(
      heading,
      "title",
      () => project?.path ?? runtime.ui.t("Unavailable project"),
    );
    heading.append(runtime.ui.icon("i-folder"), label);
    section.append(heading);
    // Native `toggle` is queued after activation. A concurrent activity repaint can replace this node first and lose the click. Commit the summary's pointer/keyboard click to the one disclosure owner synchronously, then project it onto this details element.
    heading.addEventListener("click", (event) => {
      event.preventDefault();
      const open = !runtime.state.expandedProjects.has(id);
      if (open) runtime.state.expandedProjects.add(id);
      else runtime.state.expandedProjects.delete(id);
      section.open = open;
    });
    if (project) {
      // One button holds the project's actions, and a right click on the row opens the same menu.
      const owner = `project:${id}`;
      const more = runtime.ui.el(
        "button",
        "btn row-menu-button project-menu",
      ) as HTMLButtonElement;
      more.type = "button";
      more.dataset.rowMenu = owner;
      more.append(runtime.ui.icon("i-more-vertical"));
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute(
        "aria-expanded",
        String(runtime.helpers.rowMenuOpenFor(owner)),
      );
      runtime.ui.ui(more, "title", () => runtime.ui.t("More options"));
      runtime.ui.ui(more, "aria-label", () => runtime.ui.t("More options"));
      const menu = (at?: { x: number; y: number }) => ({
        owner,
        at,
        label: () =>
          runtime.state.projects.find((row) => row.id === id)?.name ??
          runtime.ui.t("Unavailable project"),
        anchor: () => runtime.helpers.rowMenuButton(owner),
        items: () => runtime.helpers.projectMenuItems(id),
      });
      more.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        runtime.helpers.toggleRowMenu(menu());
      });
      heading.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        runtime.helpers.openRowMenu(
          menu({ x: event.clientX, y: event.clientY }),
        );
      });
      // The project's primary action, beside its menu rather than inside it: one click (+)
      const create = runtime.ui.el(
        "button",
        "btn row-menu-button project-new",
      ) as HTMLButtonElement;
      create.type = "button";
      create.dataset.newProject = id;
      create.append(runtime.ui.icon("i-plus"));
      runtime.ui.ui(create, "title", () =>
        runtime.ui.t("New chat in this project"),
      );
      runtime.ui.ui(create, "aria-label", () =>
        runtime.ui.t("New chat in this project"),
      );
      create.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        runtime.actions.selectNewChat(id);
      });
      heading.append(create, more);
    }
    const tasks = projectRows.get(id) ?? [];
    const count =
      runtime.state.projectVisibleCounts.get(id) ??
      runtime.constants.PROJECT_TASK_PAGE_SIZE;
    const shown = tasks.filter(
      (task, index) => index < count || task.selected,
    );
    section.append(...shown.flatMap((task) => task.rows));
    if (shown.length < tasks.length) {
      const more = runtime.ui.el("button", "btn project-show-more", () =>
        runtime.ui.t("Show more"),
      ) as HTMLButtonElement;
      more.type = "button";
      runtime.ui.ui(more, "aria-label", () =>
        runtime.ui.t("Show more tasks in {0}", [
          project?.name ?? runtime.ui.t("this project"),
        ]),
      );
      more.addEventListener("click", () => {
        runtime.state.projectVisibleCounts.set(
          id,
          count + runtime.constants.PROJECT_TASK_PAGE_INCREMENT,
        );
        paintSessions();
      });
      section.append(more);
    }
    projectSections.push(section);
  }
  return projectSections;
}
