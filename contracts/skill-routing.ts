export interface SkillRoutingMetadata {
  id: string;
  revision: string;
  name: string;
  description: string;
  displayName?: string;
  shortDescription?: string;
  allowImplicitInvocation: boolean;
}

export interface RoutedSkillSelection {
  id: string;
  revision: string;
}

const NAME_TOKEN_PATTERN = /[\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}\s-]+/gu;

function nameTokens(value: string): string[] {
  return value.normalize('NFC').toLowerCase().match(NAME_TOKEN_PATTERN) ?? [];
}

function tokenIndex(tokens: readonly string[]): string {
  return `,${tokens.map(token => JSON.stringify(token)).join(',')},`;
}

function candidateNames(candidate: SkillRoutingMetadata): string[][] {
  const variants = new Map<string, string[]>();
  for (const value of [candidate.id, candidate.name, candidate.displayName ?? '']) {
    const tokens = nameTokens(value);
    if (!tokens.length) continue;
    variants.set(tokenIndex(tokens), tokens);
    if (tokens[0] === 'using' && tokens.length > 1) {
      const spokenAlias = ['use', ...tokens.slice(1)];
      variants.set(tokenIndex(spokenAlias), spokenAlias);
    }
  }
  return [...variants.values()];
}

function matchesCandidate(authoredIndex: string, candidate: SkillRoutingMetadata): boolean {
  return candidateNames(candidate).some(name => authoredIndex.includes(tokenIndex(name)));
}

export function routeSkillMetadata(authored: string, candidates: readonly SkillRoutingMetadata[]): RoutedSkillSelection[] {
  const authoredTokens = nameTokens(authored);
  if (!authoredTokens.length) return [];
  const authoredIndex = tokenIndex(authoredTokens);
  let selection: RoutedSkillSelection | undefined;
  for (const candidate of candidates) {
    if (!candidate.allowImplicitInvocation || !matchesCandidate(authoredIndex, candidate)) continue;
    if (selection) return [];
    selection = { id: candidate.id, revision: candidate.revision };
  }
  return selection ? [selection] : [];
}
