import { afterEach, describe, expect, it, vi } from "vitest";
import { createHookRenderer } from "./test-hook-renderer";
import { CatalogWorkspace } from "./catalog-workspace";
import { CatalogServiceEditor } from "./catalog-service-editor";

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
function render(
  token: string,
  organizationId?: string,
  onOpenSecurity?: () => void,
) {
  return hooks.current!.render(() =>
    CatalogWorkspace({
      token,
      organizationId,
      onOpenSecurity,
      query: "",
      onDevelopmentLogin: async () => {},
    }),
  );
}
type Node = { type: unknown; props: Record<string, any> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  return text((value as Node).props?.children);
}
function button(tree: unknown, label: string) {
  const node = nodes(tree).find(
    (candidate) => candidate.type === "button" && text(candidate) === label,
  );
  expect(node).toBeDefined();
  return node!;
}
function editor(tree: unknown) {
  const node = nodes(tree).find(
    (candidate) => candidate.type === CatalogServiceEditor,
  );
  expect(node).toBeDefined();
  return node!;
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
    const action = button(tree, "刷新");
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
    const action = button(render("staff-a"), "上架");
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

const completeService = {
  ...privateService,
  slug: "service-fixture",
  category: "MASSAGE",
  organizationId: "org-a",
  description: "仅供隔离测试使用的服务介绍文字。",
  badge: undefined,
  featured: false,
  steps: ["测试流程"],
  boundaries: ["测试服务说明"],
  updatedAt: "2026-10-30T00:00:00.000Z",
};
const validInput = {
  name: "新服务项目",
  category: "MASSAGE",
  subtitle: "服务卖点介绍",
  description: "这里填写真实服务介绍，供用户了解。",
  durationMinutes: 80,
  priceFen: 29801,
  badge: null,
  featured: false,
  steps: ["第一步", "第二步"],
  boundaries: ["平台提供保健放松服务"],
};

describe("catalog management writes", () => {
  it("keeps a conflicting draft until explicit discard and reopens the fresh displayed version", async () => {
    hooks.current = createHookRenderer();
    const latest = {
      ...completeService,
      name: "其他管理员保存的新名称",
      updatedAt: "2026-10-30T00:01:00.000Z",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([completeService]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: "项目已被其他管理员修改，请刷新后重试" }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(response([latest]))
      .mockResolvedValueOnce(response([latest]))
      .mockResolvedValueOnce(response({ ...latest, ...validInput }))
      .mockResolvedValueOnce(response([{ ...latest, ...validInput }]));
    vi.stubGlobal("fetch", fetcher);
    render("staff-a", "org-a");
    hooks.current.flushEffects();
    await flush();
    button(render("staff-a", "org-a"), "编辑").props.onClick();
    await editor(render("staff-a", "org-a")).props.onSave(validInput);
    const conflict = render("staff-a", "org-a");
    expect(text(conflict)).toContain("会丢弃尚未保存的内容");
    expect(editor(conflict).props.service.updatedAt).toBe(
      completeService.updatedAt,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);

    // An ordinary list refresh must not silently replace the open draft.
    button(conflict, "刷新").props.onClick();
    await flush();
    const refreshed = render("staff-a", "org-a");
    expect(text(refreshed)).toContain(latest.name);
    expect(editor(refreshed).props.service.updatedAt).toBe(
      completeService.updatedAt,
    );
    button(refreshed, "关闭编辑并刷新").props.onClick();
    expect(
      nodes(render("staff-a", "org-a")).some(
        (node) => node.type === CatalogServiceEditor,
      ),
    ).toBe(false);
    await flush();
    button(render("staff-a", "org-a"), "编辑").props.onClick();
    const freshEditor = editor(render("staff-a", "org-a"));
    expect(freshEditor.props.service.updatedAt).toBe(latest.updatedAt);
    await freshEditor.props.onSave(validInput);
    const writes = fetcher.mock.calls.filter(
      ([, options]) => options?.method === "PATCH",
    );
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0]![1].body).expectedUpdatedAt).toBe(
      completeService.updatedAt,
    );
    expect(JSON.parse(writes[1]![1].body).expectedUpdatedAt).toBe(
      latest.updatedAt,
    );
    expect(text(render("staff-a", "org-a"))).toContain("项目内容已保存");
  });

  it("deletes an unreferenced downlisted project only after confirmation and reloads the list", async () => {
    hooks.current = createHookRenderer();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([completeService]))
      .mockResolvedValueOnce(
        response({ id: completeService.id, deleted: true }),
      )
      .mockResolvedValueOnce(response([]));
    vi.stubGlobal("fetch", fetcher);
    render("staff-a", "org-a");
    hooks.current.flushEffects();
    await flush();
    button(render("staff-a", "org-a"), "删除").props.onClick();
    button(render("staff-a", "org-a"), "确认删除项目").props.onClick();
    await flush();
    const next = render("staff-a", "org-a");
    expect(text(next)).toContain("项目已删除。");
    expect(text(next)).not.toContain(completeService.name);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("offers the security page only after a real step-up error and does not automatically resubmit", async () => {
    hooks.current = createHookRenderer();
    const openSecurity = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([completeService]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: "此敏感操作需要先在账户安全完成动态码验证",
          }),
          { status: 403 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    render("staff-a", "org-a", openSecurity);
    hooks.current.flushEffects();
    await flush();
    button(render("staff-a", "org-a", openSecurity), "编辑").props.onClick();
    await editor(render("staff-a", "org-a", openSecurity)).props.onSave(
      validInput,
    );
    const failed = render("staff-a", "org-a", openSecurity);
    expect(editor(failed).props.service.id).toBe(completeService.id);
    expect(text(failed)).toContain("系统不会自动提交");
    button(failed, "前往账户安全验证").props.onClick();
    expect(openSecurity).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retains the same creation request identifier after an uncertain failure", async () => {
    hooks.current = createHookRenderer();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([]))
      .mockRejectedValueOnce(new TypeError("isolated network failure"))
      .mockResolvedValueOnce(response({ ...completeService, ...validInput }))
      .mockResolvedValueOnce(response([{ ...completeService, ...validInput }]));
    vi.stubGlobal("fetch", fetcher);
    render("staff-a", "org-a");
    hooks.current.flushEffects();
    await flush();
    button(render("staff-a", "org-a"), "新增服务项目").props.onClick();
    await editor(render("staff-a", "org-a")).props.onSave(validInput);
    expect(text(render("staff-a", "org-a"))).not.toContain(
      "项目已新增，当前为下架状态",
    );
    await editor(render("staff-a", "org-a")).props.onSave(validInput);
    const first = JSON.parse(fetcher.mock.calls[1]![1].body);
    const retry = JSON.parse(fetcher.mock.calls[2]![1].body);
    expect(retry.clientRequestId).toBe(first.clientRequestId);
    expect(retry).toEqual(first);
  });

  it("creates one unpublished project after explicit review and refreshes the shared catalog", async () => {
    hooks.current = createHookRenderer();
    const pending = deferred<Response>();
    const created = {
      ...completeService,
      ...validInput,
      id: "created-project",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([]))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response([created]));
    vi.stubGlobal("fetch", fetcher);
    render("staff-a", "org-a");
    hooks.current.flushEffects();
    await flush();
    button(render("staff-a", "org-a"), "新增服务项目").props.onClick();
    const form = editor(render("staff-a", "org-a"));
    expect(form.props.service).toBeUndefined();
    const save = form.props.onSave;
    const first = save(validInput);
    const duplicate = save(validInput);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, options] = fetcher.mock.calls[1]!;
    expect(String(url)).toMatch(/\/admin\/catalog\/services$/);
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer staff-a",
    });
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({ ...validInput, organizationId: "org-a" });
    expect(body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).not.toHaveProperty("published");
    pending.resolve(response(created));
    await Promise.all([first, duplicate]);
    const next = render("staff-a", "org-a");
    expect(text(next)).toContain("项目已新增，当前为下架状态");
    expect(text(next)).toContain(validInput.name);
    expect(nodes(next).some((node) => node.type === CatalogServiceEditor)).toBe(
      false,
    );
    expect(
      fetcher.mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(1);
  });

  it("sends the displayed version with an edit and retains server errors without showing false success", async () => {
    hooks.current = createHookRenderer();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([completeService]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: "项目已被其他管理员修改，请刷新后重试" }),
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    render("staff-a", "org-a");
    hooks.current.flushEffects();
    await flush();
    button(render("staff-a", "org-a"), "编辑").props.onClick();
    const form = editor(render("staff-a", "org-a"));
    await form.props.onSave(validInput);
    const options = fetcher.mock.calls[1]![1];
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body)).toEqual({
      ...validInput,
      expectedUpdatedAt: completeService.updatedAt,
    });
    const next = render("staff-a", "org-a");
    expect(text(next)).toContain("请刷新后重试");
    expect(text(next)).not.toContain("项目内容已保存");
    expect(editor(next).props.service.id).toBe(completeService.id);
  });

  it("requires a separate delete confirmation and preserves a project with historical references", async () => {
    hooks.current = createHookRenderer();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([completeService]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: "项目已关联历史订单，请下架并保留记录" }),
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    render("staff-a", "org-a");
    hooks.current.flushEffects();
    await flush();
    button(render("staff-a", "org-a"), "删除").props.onClick();
    const review = render("staff-a", "org-a");
    expect(text(review)).toContain("删除项目：" + completeService.name);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await button(review, "确认删除项目").props.onClick();
    await flush();
    expect(fetcher.mock.calls[1]![1].method).toBe("DELETE");
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
      expectedUpdatedAt: completeService.updatedAt,
    });
    const next = render("staff-a", "org-a");
    expect(text(next)).toContain("请下架并保留记录");
    expect(text(next)).toContain(completeService.name);
    expect(text(next)).not.toContain("项目已删除。");
  });

  it("offers downlisting instead of deleting a currently published service", async () => {
    hooks.current = createHookRenderer();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response([{ ...completeService, published: true }]),
      );
    vi.stubGlobal("fetch", fetcher);
    render("staff-a", "org-a");
    hooks.current.flushEffects();
    await flush();
    button(render("staff-a", "org-a"), "删除").props.onClick();
    const review = render("staff-a", "org-a");
    expect(button(review, "下架并保留记录")).toBeDefined();
    expect(
      nodes(review).some(
        (node) => node.type === "button" && text(node) === "确认删除项目",
      ),
    ).toBe(false);
    button(review, "取消").props.onClick();
    expect(text(render("staff-a", "org-a"))).not.toContain("删除项目：");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("ignores old organization writes and does not refill their editor or rows", async () => {
    hooks.current = createHookRenderer();
    const pending = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([completeService]))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response([]));
    vi.stubGlobal("fetch", fetcher);
    render("staff-a", "org-a");
    hooks.current.flushEffects();
    await flush();
    button(render("staff-a", "org-a"), "编辑").props.onClick();
    const save = editor(render("staff-a", "org-a")).props.onSave(validInput);
    expect(text(render("staff-a", "org-b"))).not.toContain(
      completeService.name,
    );
    hooks.current.flushEffects();
    await flush();
    pending.resolve(response({ ...completeService, ...validInput }));
    await save;
    const current = render("staff-a", "org-b");
    expect(text(current)).not.toContain(validInput.name);
    expect(
      nodes(current).some((node) => node.type === CatalogServiceEditor),
    ).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not claim an operation succeeded when an HTML fallback is returned", async () => {
    hooks.current = createHookRenderer();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response([completeService]))
        .mockResolvedValueOnce(
          new Response("<html>unexpected fallback</html>"),
        ),
    );
    render("staff-a", "org-a");
    hooks.current.flushEffects();
    await flush();
    button(render("staff-a", "org-a"), "编辑").props.onClick();
    await editor(render("staff-a", "org-a")).props.onSave(validInput);
    expect(text(render("staff-a", "org-a"))).toContain("接口未返回有效结果");
    expect(text(render("staff-a", "org-a"))).not.toContain("项目内容已保存");
  });
});
