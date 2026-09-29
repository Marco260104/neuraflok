import { EditorView } from 'codemirror';
import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export const workspaceEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    minHeight: '0',
    color: 'var(--ink)',
    backgroundColor: 'transparent',
    fontSize: 'calc(12px * var(--text-scale, 1))'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    minHeight: '0',
    fontFamily: 'var(--mono)',
    lineHeight: '1.55',
    overflow: 'auto'
  },
  '.cm-content': {
    minHeight: '100%',
    padding: '10px 0',
    caretColor: 'var(--ink)'
  },
  '.cm-line': { padding: '0 12px 0 8px' },
  '.cm-gutters': {
    backgroundColor: 'var(--sunk)',
    color: 'var(--faint)',
    border: '0',
    borderRight: '1px solid var(--line)'
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px', minWidth: '30px' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--soft)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hover) 62%, transparent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--accent-wash)'
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--hover)',
    border: '1px solid var(--line)',
    color: 'var(--soft)'
  },
  '.cm-tooltip': {
    border: '1px solid var(--edge)',
    backgroundColor: 'var(--card)',
    color: 'var(--ink)'
  },
  '.cm-panels': { backgroundColor: 'var(--card)', color: 'var(--ink)' },
  '.cm-searchMatch': { backgroundColor: 'var(--syntax-search)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--syntax-search-selected)' },
  '.cm-changedLine, .cm-inlineChangedLine': { backgroundColor: 'var(--green-wash)' },
  '.cm-changedText': { backgroundColor: 'color-mix(in srgb, var(--green) 24%, transparent)' },
  '.cm-deletedChunk': { backgroundColor: 'var(--red-wash)', color: 'var(--ink)' },
  '.cm-deletedText': { backgroundColor: 'color-mix(in srgb, var(--red) 24%, transparent)' },
  '.cm-changedLineGutter': { backgroundColor: 'var(--green)' },
  '.cm-deletedLineGutter': { backgroundColor: 'var(--red)' },
  '.cm-collapsedLines': { backgroundColor: 'var(--card)', color: 'var(--soft)', borderColor: 'var(--line)' }
});

export const workspaceSyntaxTheme = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword], color: 'var(--syntax-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.character, tags.docString, tags.attributeValue], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom], color: 'var(--syntax-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: 'var(--syntax-type)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--syntax-property)' },
  { tag: [tags.regexp, tags.escape], color: 'var(--syntax-regexp)' },
  { tag: [tags.operator, tags.derefOperator, tags.arithmeticOperator, tags.logicOperator, tags.compareOperator], color: 'var(--syntax-operator)' },
  { tag: [tags.labelName, tags.macroName], color: 'var(--syntax-label)' },
  { tag: tags.invalid, color: 'var(--red)', textDecoration: 'underline wavy' }
]);
