import { afterEach, describe, expect, it, vi } from "vitest";
import { createHookRenderer } from "./test-hook-renderer";
import { CatalogWorkspace } from "./catalog-workspace";

const hooks = vi.hoisted(() => ({
  current: null as ReturnType<typeof createHookRenderer> | null,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial?: unknown) => hooks.current!.useState(initial),
    useMemo: (...args: Parameters<typeof actual.useMemo>) =>
      hooks.current!.useMemo(...args),
    useCallback: (...args: Parameters<typeof actual.useCallback>) =>
      hooks.current!.useCallback(...args),
    useRef: (...args: Parameters<typeof actual.useRef>) =>
      hooks.current!.useRef(...args),
    useEffect: (...args: Parameters<typeof actual.useEffect>) =>
      hooks.current!.useEffect(args[0], args[1] ?? []),
  };
});

afterEach(() => {
  hooks.current?.unmount();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
const publicService = {
  id: "public-service",
  name: "公开项目",
  subtitle: "公开说明",
  category: "MASSAGE_RELAXATION",
  durationMinutes: 60,
  priceFen: 19800,
};
const privateService = {
  ...publicService,
  id: "private-service",
  name: "未发布内部项目",
  published: false,
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), { status });
const flush = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
function render(token: string) {
  return hooks.current!.render(() =>
    CatalogWorkspace({ token, query: "", onDevelopmentLogin: async () => {} }),
  );
}

describe("catalog identity isolation", () => {
  it("does not expose authenticated rows while switching to the anonymous public catalog", async () => {
    hooks.current = createHookRenderer();
    const pendingPublic = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response([privateService]))
        .mockReturnValueOnce(pendingPublic.promise),
    );
    render("staff-a");
    hooks.current.flushEffects();
    await flush();
    expect(JSON.stringify(render("staff-a"))).toContain("未发布内部项目");
    expect(JSON.stringify(render(""))).not.toContain("未发布内部项目");
  });

  it("ignores a late authenticated response after the public response has completed", async () => {
    hooks.current = createHookRenderer();
    const staff = deferred<Response>(),
      publicRequest = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(staff.promise)
        .mockReturnValueOnce(publicRequest.promise),
    );
    render("staff-a");
    hooks.current.flushEffects();
    render("");
    hooks.current.flushEffects();
    publicRequest.resolve(response([publicService]));
    await flush();
    staff.resolve(response([privateService]));
    await flush();
    const result = JSON.stringify(render(""));
    expect(result).toContain("公开项目");
    expect(result).not.toContain("未发布内部项目");
    expect(result).not.toContain('"className":"primary-action compact"');
    expect(result).not.toContain('"className":"danger-action"');
  });

  it("clears old private rows on a failed current refresh", async () => {
    hooks.current = createHookRenderer();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response([privateService]))
        .mockResolvedValueOnce(response([], 503)),
    );
    render("staff-a");
    hooks.current.flushEffects();
    await flush();
    const tree = render("staff-a");
    const action = tree.props.children[0].props.children[1].props.children[1];
    action.props.onClick();
    await flush();
    expect(JSON.stringify(render("staff-a"))).not.toContain("未发布内部项目");
  });

  it("never renders management controls anonymously, even if an unexpected response includes admin fields", async () => {
    hooks.current = createHookRenderer();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response([privateService, { ...publicService, published: true }]),
        ),
    );
    render("");
    hooks.current.flushEffects();
    await flush();
    const result = JSON.stringify(render(""));
    expect(result).toContain("公开项目");
    expect(result).toContain("只读");
    expect(result).not.toContain("未发布内部项目");
    expect(result).not.toContain('"className":"danger-action"');
  });

  it("does not refresh or refill an old private context after an in-flight mutation completes", async () => {
    hooks.current = createHookRenderer();
    const mutation = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([privateService]))
      .mockReturnValueOnce(mutation.promise)
      .mockResolvedValueOnce(response([publicService]));
    vi.stubGlobal("fetch", fetcher);
    render("staff-a");
    hooks.current.flushEffects();
    await flush();
    const table = render("staff-a").props.children[3];
    const action = table.props.children[1][0].props.children[5].props.children;
    action.props.onClick();
    render("");
    hooks.current.flushEffects();
    await flush();
    mutation.resolve(response({}));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(render(""))).toContain("公开项目");
    expect(JSON.stringify(render(""))).not.toContain("未发布内部项目");
  });
});
