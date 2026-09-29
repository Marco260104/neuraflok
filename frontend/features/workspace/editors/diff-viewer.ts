import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { workspaceEditorTheme, workspaceSyntaxTheme } from './theme.js';
import type { ProjectDiffViewer } from './types.js';

export async function createProjectDiffViewer(options: {
  parent: HTMLElement;
  filename: string;
  baseText: string;
  currentText: string;
}): Promise<ProjectDiffViewer> {
  const { getChunks, unifiedMergeView } = await import('@codemirror/merge');
  const description = LanguageDescription.matchFilename(languages, options.filename);
  let support = null;
  if (description) {
    try { support = await description.load(); }
    catch { /* Plain text keeps the diff readable when a parser is unavailable. */ }
  }

  const view = new EditorView({
    doc: options.currentText,
    parent: options.parent,
    extensions: [
      basicSetup,
      workspaceEditorTheme,
      syntaxHighlighting(workspaceSyntaxTheme),
      EditorView.lineWrapping,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      ...(support ? [support] : []),
      unifiedMergeView({
        original: options.baseText,
        highlightChanges: true,
        syntaxHighlightDeletions: true,
        allowInlineDiffs: true,
        mergeControls: false,
        gutter: true,
        collapseUnchanged: { margin: 3, minSize: 6 }
      })
    ]
  });
  const firstChange = getChunks(view.state)?.chunks[0];
  if (firstChange) {
    view.dispatch({ effects: EditorView.scrollIntoView(
      Math.min(firstChange.fromB, view.state.doc.length), { y: 'center' }
    ) });
  }
  return { view, language: description?.name ?? 'Plain text', destroy: () => view.destroy() };
}
