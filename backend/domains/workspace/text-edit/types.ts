export type Newline = '\n' | '\r\n' | '\r';

export interface LogicalText {
  lines: string[];
  endings: string[];
  newline: Newline;
  finalNewline: boolean;
}

export interface TextSpan {
  start: number;
  end: number;
}

export interface MatchTier {
  readonly label: string;
  readonly normalize: (value: string) => string;
}

export interface SpanMatch {
  spans: TextSpan[];
  tier: MatchTier;
}

export interface TextEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface AppliedTextEdit {
  text: string;
  replacements: number;
  tier: string;
}
