// Small synchronous hook driver for request-race tests; no DOM or real network.
export function createHookRenderer() {
  const slots: unknown[] = [];
  let cursor = 0;
  const pending: Array<() => void> = [];
  const cleanups = new Map<number, () => void>();
  function changed(a: readonly unknown[] | undefined, b: readonly unknown[]) {
    return (
      !a ||
      a.length !== b.length ||
      a.some((value, index) => value !== b[index])
    );
  }
  return {
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] =
          typeof initial === "function" ? (initial as () => T)() : initial;
      return [
        slots[index] as T,
        (next: T | ((previous: T) => T)) => {
          slots[index] =
            typeof next === "function"
              ? (next as (previous: T) => T)(slots[index] as T)
              : next;
        },
      ] as const;
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    useMemo<T>(factory: () => T, dependencies: readonly unknown[]) {
      const index = cursor++;
      const previous = slots[index] as
        | { value: T; dependencies: readonly unknown[] }
        | undefined;
      if (changed(previous?.dependencies, dependencies))
        slots[index] = { value: factory(), dependencies };
      return (slots[index] as { value: T }).value;
    },
    useCallback<T>(callback: T, dependencies: readonly unknown[]): T {
      return this.useMemo(() => callback, dependencies);
    },
    useEffect(
      effect: () => void | (() => void),
      dependencies: readonly unknown[],
    ) {
      const index = cursor++;
      if (
        changed(slots[index] as readonly unknown[] | undefined, dependencies)
      ) {
        slots[index] = dependencies;
        pending.push(() => {
          cleanups.get(index)?.();
          const cleanup = effect();
          if (cleanup) cleanups.set(index, cleanup);
          else cleanups.delete(index);
        });
      }
    },
    render<T>(render: () => T) {
      cursor = 0;
      return render();
    },
    flushEffects() {
      pending.splice(0).forEach((effect) => effect());
    },
    unmount() {
      cleanups.forEach((cleanup) => cleanup());
      cleanups.clear();
    },
  };
}
