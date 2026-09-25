import path from 'node:path';

/** Translates a glob into a regex. Supports *, ?, ** and nothing else, on purpose. */
export function globToRegExp(pattern: string, caseSensitive: boolean): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // "**/" spans zero or more directories; a bare "**" spans anything.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, caseSensitive ? '' : 'i');
}

export function compileIncludeMatcher(pattern: string, caseSensitive: boolean): (relPath: string) => boolean {
  const re = globToRegExp(pattern, caseSensitive);
  const matchBaseName = !pattern.includes('/');
  return (relPath: string): boolean => {
    if (re.test(relPath)) return true;
    // A pattern with no slash is conventionally matched against the file name alone.
    return matchBaseName && re.test(path.basename(relPath));
  };
}

/** Translate the connector's deliberately small glob grammar into ripgrep's richer grammar. */
export function ripgrepIncludeGlob(pattern: string): string {
  let out = '';
  for (const char of pattern) {
    // These are the only metacharacters the connector itself promises.
    if (char === '*' || char === '?' || char === '/') {
      out += char;
      continue;
    }
    // Ripgrep assigns extra meaning to these; the connector treats them literally.
    if (char === '\\' || char === '[' || char === ']' || char === '{' || char === '}' || char === '!') {
      out += `\\${char}`;
      continue;
    }
    out += char;
  }
  return out;
}

/** Converts the connector's folder-name exclude syntax to ripgrep's glob syntax. Excludes are deliberately much simpler than globs: a folder name is literal, except for one optional trailing `*` meaning "this name prefix". The JS fallback enforces exactly that and is case-insensitive, so passing the raw text to `rg --glob` was wrong in two ways: stored casing such as `BUILD` bypassed `build`, and characters such as `[` acquired glob semantics. Escape every glob metacharacter in the literal part and use `--iglob` for parity. */
export function ripgrepExcludeGlob(raw: string): string {
  const prefix = raw.endsWith('*');
  const literal = prefix ? raw.slice(0, -1) : raw;
  const escaped = literal.replace(/[\\*?\[\]{}]/g, '\\$&');
  return `!**/${escaped}${prefix ? '*' : ''}/**`;
}
