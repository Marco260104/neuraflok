type LiveBinding<T> = {
  read: () => T;
  write?: (value: T) => void;
};

type BindingMap = Record<string, LiveBinding<any>>;
type BindingValues<T extends BindingMap> = {
  [Key in keyof T]: T[Key] extends LiveBinding<infer Value> ? Value : never;
};

export function liveBinding<Value>(read: () => Value, write: (value: Value) => void): LiveBinding<Value> {
  return { read, write };
}

export function liveGetter<Value>(read: () => Value): LiveBinding<Value> {
  return { read };
}

export function createChatRuntimeBindings<Static extends object, Dynamic extends BindingMap>(
  fixed: Static,
  dynamic: Dynamic
): Static & BindingValues<Dynamic> {
  const runtime = { ...fixed };
  for (const [key, binding] of Object.entries(dynamic)) {
    Object.defineProperty(runtime, key, {
      configurable: true,
      enumerable: true,
      get: binding.read,
      ...(binding.write ? { set: binding.write } : {})
    });
  }
  return runtime as Static & BindingValues<Dynamic>;
}