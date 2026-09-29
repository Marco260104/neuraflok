import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { workspaceEditorTheme, workspaceSyntaxTheme } from './theme.js';
import type { ProjectCodeEditor } from './types.js';

export async function createProjectCodeEditor(options: {
  parent: HTMLElement;
  filename: string;
  text: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}): Promise<ProjectCodeEditor> {
  const description = LanguageDescription.matchFilename(languages, options.filename);
  let support = null;
  if (description) {
    try { support = await description.load(); }
    catch { /* Plain text remains usable when a language parser is unavailable. */ }
  }

  const view = new EditorView({
    doc: options.text,
    parent: options.parent,
    extensions: [
      basicSetup,
      workspaceEditorTheme,
      syntaxHighlighting(workspaceSyntaxTheme),
      EditorView.lineWrapping,
      EditorState.lineSeparator.of(options.text.includes('\r\n') ? '\r\n' : '\n'),
      EditorState.changeFilter.of(transaction => transaction.newDoc.length <= 256 * 1024),
      ...(support ? [support] : []),
      ...(options.readOnly ? [EditorView.editable.of(false), EditorState.readOnly.of(true)] : []),
      EditorView.updateListener.of(update => {
        if (update.docChanged) options.onChange?.(update.state.sliceDoc());
      })
    ]
  });

  return {
    view,
    language: description?.name ?? 'Plain text',
    getValue: () => view.state.sliceDoc(),
    focus: () => view.focus(),
    destroy: () => view.destroy()
  };
}
