import type { EditorView } from 'codemirror';

export interface ProjectCodeEditor {
  view: EditorView;
  language: string;
  getValue(): string;
  focus(): void;
  destroy(): void;
}

export interface ProjectDiffViewer {
  view: EditorView;
  language: string;
  destroy(): void;
}
