import { contextBridge } from "electron";
import { createDesktopApi } from "./api/desktop.js";
import { createSkillsApi } from "./api/skills.js";
import { createAttachmentsApi } from "./api/attachments.js";
import { createBrowserApi } from "./api/browser.js";
import { createProjectsApi } from "./api/projects.js";
import { createSessionsApi } from "./api/sessions.js";
import { createEventsApi } from "./api/events.js";

const api = {
  ...createDesktopApi(),
  ...createSkillsApi(),
  ...createAttachmentsApi(),
  ...createBrowserApi(),
  ...createProjectsApi(),
  ...createSessionsApi(),
  ...createEventsApi()
};

export type { GoalModelPage, SessionDetail, SessionList, SessionListCursor, SettingsPatch } from "./api/contracts.js";
export type AppApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
