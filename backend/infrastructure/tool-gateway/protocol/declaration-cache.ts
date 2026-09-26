const declarations = new Map<string, { key: string; value: object }>();

export function toolDeclaration<T extends object>(name: string, create: () => T, key = ''): T {
  const previous = declarations.get(name);
  if (previous?.key === key) return previous.value as T;
  const value = Object.freeze(create());
  declarations.set(name, { key, value });
  return value;
}
