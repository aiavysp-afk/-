import { afterEach, describe, expect, it, vi } from "vitest";
import { createHookRenderer } from "./test-hook-renderer";
import { SchedulingWorkspace } from "./admin-resources";

const hooks = vi.hoisted(() => ({
  current: null as ReturnType<typeof createHookRenderer> | null,
  key: "",
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => hooks.current!.useState(initial),
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
  hooks.current = null;
  hooks.key = "";
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), { status });
const flush = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
type Node = { type: unknown; props: Record<string, any> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function control(tree: unknown, type: string, property: string, value: string) {
  const node = nodes(tree).find(
    (item) => item.type === type && item.props[property] === value,
  );
  expect(node).toBeDefined();
  return node!;
}
function createButton(tree: unknown) {
  const node = nodes(tree).find(
    (item) =>
      item.type === "button" &&
      ["创建有效排班", "创建中…"].includes(item.props.children),
  );
  expect(node).toBeDefined();
  return node!;
}
function render(token = "session-a", organizationId = "org-a") {
  const props = { token, organizationId, login: async () => {} };
  const element = SchedulingWorkspace(props);
  // Reflect React's keyed identity remount; the component uses real callbacks.
  if (!hooks.current || hooks.key !== element.key) {
    hooks.current?.unmount();
    hooks.current = createHookRenderer();
    hooks.key = element.key ?? "";
  }
  return hooks.current.render(() =>
    (element.type as typeof SchedulingWorkspace)(props),
  );
}
const board = { technicians: [{ id: "tech-a", displayName: "技师甲" }] };
const shift = (id: string) => ({
  id,
  therapistDisplayName: id,
  startsAt: "2026-10-18T01:00:00.000Z",
  endsAt: "2026-10-18T10:00:00.000Z",
  status: "ACTIVE",
});

describe("real scheduling component request races", () => {
  it("does not replace current day B rows with a late day A reply", async () => {
    const old = deferred<Response>(),
      current = deferred<Response>();
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(board))
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(response(board))
      .mockReturnValueOnce(current.promise);
    vi.stubGlobal("fetch", send);
    let tree = render();
    hooks.current!.flushEffects();
    control(tree, "input", "type", "date").props.onChange({
      target: { value: "2026-10-20" },
    });
    tree = render();
    hooks.current!.flushEffects();
    expect(JSON.stringify(tree)).not.toContain("旧日期排班");
    current.resolve(response([shift("当前日期排班")]));
    await flush();
    old.resolve(response([shift("旧日期排班")]));
    await flush();
    const result = JSON.stringify(render());
    expect(result).toContain("当前日期排班");
    expect(result).not.toContain("旧日期排班");
    expect(result).toContain("2026-10-20");
  });

  it("late failure cannot clear current loading or write an old error", async () => {
    const old = deferred<Response>(),
      current = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(board))
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(response(board))
        .mockReturnValueOnce(current.promise),
    );
    const first = render();
    hooks.current!.flushEffects();
    control(first, "input", "type", "date").props.onChange({
      target: { value: "2026-10-20" },
    });
    render();
    hooks.current!.flushEffects();
    old.reject(new Error("old-day-error"));
    await flush();
    const pending = JSON.stringify(render());
    expect(pending).toContain("正在读取当日排班");
    expect(pending).not.toContain("old-day-error");
    expect(pending).not.toContain("当日暂无排班");
    current.resolve(response([]));
    await flush();
    expect(JSON.stringify(render())).toContain("当日暂无排班");
  });

  it("hides old private rows immediately before the next date effect runs and refuses an obsolete submit callback", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(board))
      .mockResolvedValueOnce(response([shift("旧私有排班")]))
      .mockResolvedValueOnce(response(board))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ id: "current-day-created" }))
      .mockResolvedValueOnce(response(board))
      .mockResolvedValueOnce(response([]));
    vi.stubGlobal("fetch", send);
    render();
    hooks.current!.flushEffects();
    await flush();
    const first = render();
    expect(createButton(first).props.disabled).toBe(false);
    const obsoleteSubmit = createButton(first).props.onClick;
    control(first, "input", "type", "date").props.onChange({
      target: { value: "2026-10-20" },
    });
    const changed = render();
    expect(JSON.stringify(changed)).not.toContain("旧私有排班");
    expect(createButton(changed).props.disabled).toBe(true);
    obsoleteSubmit();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    hooks.current!.flushEffects();
    await flush();
    expect(createButton(render()).props.disabled).toBe(false);
    createButton(render()).props.onClick();
    await flush();
    const posts = send.mock.calls.filter(
      ([, options]) => options?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]![1].body).startsAt).toBe(
      "2026-10-20T01:00:00.000Z",
    );
    expect(JSON.stringify(render())).toContain("排班已创建并写入审计记录");
  });

  it("current load failure clears private rows, does not pretend empty, and supports a controlled retry", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(board))
      .mockResolvedValueOnce(response([shift("旧私有排班")]))
      .mockResolvedValueOnce(response(board))
      .mockResolvedValueOnce(response([], 503))
      .mockResolvedValueOnce(response(board))
      .mockResolvedValueOnce(response([]));
    vi.stubGlobal("fetch", send);
    render();
    hooks.current!.flushEffects();
    await flush();
    const first = render();
    control(first, "input", "type", "date").props.onChange({
      target: { value: "2026-10-20" },
    });
    render();
    hooks.current!.flushEffects();
    await flush();
    const failed = render();
    const text = JSON.stringify(failed);
    expect(text).not.toContain("旧私有排班");
    expect(text).not.toContain("当日暂无排班");
    expect(text).toContain("排班未读取成功");
    expect(createButton(failed).props.disabled).toBe(true);
    const retry = nodes(failed).find(
      (node) =>
        node.type === "button" && node.props.children === "重新读取排班",
    );
    expect(retry).toBeDefined();
    retry!.props.onClick();
    await flush();
    expect(JSON.stringify(render())).toContain("当日暂无排班");
  });

  it("locks date during a single creation and sends only its captured current-day payload", async () => {
    const save = deferred<Response>(),
      refresh = deferred<Response>();
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(board))
      .mockResolvedValueOnce(response([]))
      .mockReturnValueOnce(save.promise)
      .mockResolvedValueOnce(response(board))
      .mockReturnValueOnce(refresh.promise);
    vi.stubGlobal("fetch", send);
    render();
    hooks.current!.flushEffects();
    await flush();
    let tree = render();
    const initialDate = control(tree, "input", "type", "date").props.value;
    createButton(tree).props.onClick();
    createButton(tree).props.onClick();
    tree = render();
    expect(control(tree, "input", "type", "date").props.disabled).toBe(true);
    control(tree, "input", "type", "date").props.onChange({
      target: { value: "2026-10-20" },
    });
    expect(control(render(), "input", "type", "date").props.value).toBe(
      initialDate,
    );
    expect(send).toHaveBeenCalledTimes(3);
    const payload = JSON.parse(send.mock.calls[2]![1].body);
    expect(payload.organizationId).toBe("org-a");
    expect(payload.therapistId).toBe("tech-a");
    expect(
      new Date(Date.parse(payload.startsAt) + 8 * 3_600_000)
        .toISOString()
        .slice(0, 10),
    ).toBe(initialDate);
    save.resolve(response({ id: "created" }));
    await flush();
    expect(JSON.stringify(render())).toContain("正在读取当日排班");
    expect(createButton(render()).props.disabled).toBe(true);
    refresh.resolve(response([shift("新创建排班")]));
    await flush();
    expect(JSON.stringify(render())).toContain("新创建排班");
  });

  it("identity remount drops private rows and a late save does not refresh or alter the new identity", async () => {
    const save = deferred<Response>();
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(board))
      .mockResolvedValueOnce(response([shift("账号甲私有排班")]))
      .mockReturnValueOnce(save.promise)
      .mockResolvedValueOnce(response(board))
      .mockResolvedValueOnce(response([shift("账号乙排班")]));
    vi.stubGlobal("fetch", send);
    render();
    hooks.current!.flushEffects();
    await flush();
    createButton(render()).props.onClick();
    const swapped = render("session-b", "org-b");
    expect(JSON.stringify(swapped)).not.toContain("账号甲私有排班");
    hooks.current!.flushEffects();
    await flush();
    save.resolve(response({ id: "old-save" }));
    await flush();
    const current = JSON.stringify(render("session-b", "org-b"));
    expect(current).toContain("账号乙排班");
    expect(current).not.toContain("账号甲私有排班");
    expect(current).not.toContain("排班已创建并写入审计记录");
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("does not submit a shift whose start date differs from the displayed date", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(board))
      .mockResolvedValueOnce(response([]));
    vi.stubGlobal("fetch", send);
    render();
    hooks.current!.flushEffects();
    await flush();
    const tree = render();
    control(tree, "input", "type", "datetime-local").props.onChange({
      target: { value: "2026-10-25T09:00" },
    });
    expect(createButton(render()).props.disabled).toBe(true);
    createButton(render()).props.onClick();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
