import { ipcRenderer } from "electron";
import type { InputAttachment } from "../../../contracts/input.js";
import type { LocalProject, ProjectColor } from "../../../contracts/workspace/projects.js";
import type { ProjectDirectoryListing, ProjectFileMutationResult, ProjectFilePreview, ProjectFileSaveResult, ProjectFilesChanged } from "../../../contracts/workspace/project-files.js";
import type { ProjectGitChanged, ProjectGitDiff, ProjectGitSnapshot } from "../../../contracts/workspace/project-git.js";
import type { ToolEditReview } from "../../../contracts/session.js";
import { call } from "./shared.js";

export function createProjectsApi() {
  return {
    listProjects: () => call<LocalProject[]>('projects:list'),
    addProject: () => call<LocalProject | null>('projects:add'),
    removeProject: (id: string) => call<LocalProject>('projects:remove', { id }),
    setProjectColor: (id: string, color: ProjectColor | null) => call<LocalProject>('projects:color', { id, color }),
    listProjectFiles: (projectId: string, directory = '') => call<ProjectDirectoryListing>('projectFiles:list', { projectId, directory }),
    watchProjectFiles: (projectId: string | null, directories: string[]) => call<boolean>('projectFiles:watch', { projectId, directories }),
    onProjectFilesChanged: (listener: (event: ProjectFilesChanged) => void): (() => void) => {
        const wrapped = (_event: unknown, change: ProjectFilesChanged): void => listener(change);
        ipcRenderer.on('projectFiles:changed', wrapped);
        return () => ipcRenderer.removeListener('projectFiles:changed', wrapped);
      },
    previewProjectFile: (projectId: string, path: string) => call<ProjectFilePreview>('projectFiles:preview', { projectId, path }),
    createProjectFileEntry: (projectId: string, directory: string, name: string, kind: 'file' | 'directory') =>
        call<ProjectFileMutationResult>('projectFiles:create', { projectId, directory, name, kind }),
    renameProjectFileEntry: (projectId: string, path: string, name: string) => call<ProjectFileMutationResult>('projectFiles:rename', { projectId, path, name }),
    saveProjectFile: (projectId: string, path: string, text: string, expectedModifiedAt: string, expectedBytes: number, expectedRevision: string) =>
        call<ProjectFileSaveResult>('projectFiles:save', { projectId, path, text, expectedModifiedAt, expectedBytes, expectedRevision }),
    deleteProjectFileEntry: (projectId: string, path: string) => call<boolean>('projectFiles:delete', { projectId, path }),
    revealProjectFileEntry: (projectId: string, path = '') => call<boolean>('projectFiles:reveal', { projectId, path }),
    attachProjectFile: (projectId: string, path: string) => call<InputAttachment>('projectFiles:attach', { projectId, path }),
    getProjectGitSnapshot: (projectId: string, baseRef?: string) => call<ProjectGitSnapshot>('projectGit:snapshot', { projectId, ...(baseRef ? { baseRef } : {}) }),
    getProjectGitDiff: (projectId: string, path: string, baseRef?: string, expectedRevision?: string) => call<ProjectGitDiff>('projectGit:diff', {
        projectId, path, ...(baseRef ? { baseRef } : {}), ...(expectedRevision ? { expectedRevision } : {})
      }),
    getToolEditReview: (sessionId: string, callId: string, changeIndex: number) =>
        call<ToolEditReview | null>('sessions:toolEditReview', { sessionId, callId, changeIndex }),
    onProjectGitChanged: (listener: (event: ProjectGitChanged) => void): (() => void) => {
        const wrapped = (_event: unknown, change: ProjectGitChanged): void => listener(change);
        ipcRenderer.on('projectGit:changed', wrapped);
        return () => ipcRenderer.removeListener('projectGit:changed', wrapped);
      }
  };
}
