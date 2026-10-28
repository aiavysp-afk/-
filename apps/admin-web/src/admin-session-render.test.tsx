import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { AuthSession, AuthUser } from "@zydj/contracts";
import { createHookRenderer } from "./test-hook-renderer";
import { App } from "./main";
import { BrowserLogin } from "./browser-login";
import {
  authenticatedFetch,
  registerAdminSession,
} from "./authenticated-fetch";

const hooks = vi.hoisted(() => {
  vi.stubGlobal("document", { getElementById: () => ({}) });
  return { current: null as ReturnType<typeof createHookRenderer> | null };
});
vi.mock("react-dom/client", () => ({
  default: { createRoot: () => ({ render() {}, unmount() {} }) },
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
    useLayoutEffect: (...args: Parameters<typeof actual.useLayoutEffect>) =>
      hooks.current!.useEffect(args[0], args[1] ?? []),
  };
});
const user: AuthUser = {
  id: "synthetic-operator",
  displayName: "测试运营",
  phoneVerified: true,
  memberships: [{ organizationId: "org-test", role: "OPERATOR" }],
};
const tokenKey = "zydj.admin.access-token";
let values: Map<string, string>;
let browserUrl: URL;
let replaceState: ReturnType<typeof vi.fn>;
beforeEach(() => {
  hooks.current = createHookRenderer();
  values = new Map([[tokenKey, "staff-a"]]);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("localStorage", { removeItem: vi.fn() });
  vi.stubGlobal("document", { title: "", getElementById: () => ({}) });
  browserUrl = new URL("https://admin.example.test/");
  replaceState = vi.fn((_data: unknown, _unused: string, url: string) => {
    browserUrl = new URL(url, browserUrl);
  });
  vi.stubGlobal("window", {
    get location() {
      return browserUrl;
    },
    history: { replaceState },
  });
});
afterEach(() => {
  hooks.current?.unmount();
  registerAdminSession("", () => {})();
  vi.unstubAllGlobals();
});
function render() {
  return hooks.current!.render(() => App());
}
function elements(value: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as ReactElement<Record<string, unknown>>;
  return [node, ...elements(node.props.children)];
}
const response = (status: number, data: unknown = {}) =>
  new Response(JSON.stringify({ data }), { status });
const flush = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("root admin session recovery", () => {
  it("removes an expired runtime session and returns to the password login page", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(200, user))
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(401));
    vi.stubGlobal("fetch", fetcher);
    render();
    hooks.current!.flushEffects();
    await flush();
    expect(JSON.stringify(render())).toContain("已登录 · 账户安全");
    await authenticatedFetch(
      "staff-a",
      "http://127.0.0.1:3100/v1/admin/catalog/services",
      { headers: { Authorization: "Bearer staff-a" } },
    );
    const tree = render();
    hooks.current!.flushEffects();
    expect(values.has(tokenKey)).toBe(false);
    expect(JSON.stringify(tree)).not.toContain("已登录 · 账户安全");
    expect(JSON.stringify(tree)).not.toContain("测试运营");
    expect(elements(tree).some((node) => node.type === BrowserLogin)).toBe(
      true,
    );
    expect(browserUrl.pathname).toBe("/login");
    expect(JSON.stringify(tree)).not.toContain('"className":"app-shell"');
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes("/auth/logout")),
    ).toBe(false);
  });

  it("keeps the root session and original login state on an invalid dynamic code", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(200, user))
        .mockResolvedValueOnce(response(401))
        .mockResolvedValueOnce(response(200, user)),
    );
    render();
    hooks.current!.flushEffects();
    await flush();
    await authenticatedFetch(
      "staff-a",
      "http://127.0.0.1:3100/v1/auth/mfa/verify",
      { method: "POST", body: "{}" },
    );
    const tree = render();
    expect(values.get(tokenKey)).toBe("staff-a");
    expect(JSON.stringify(tree)).toContain("已登录 · 账户安全");
    expect(elements(tree).some((node) => node.type === BrowserLogin)).toBe(
      false,
    );
  });

  it("ignores a successful old identity response after logout, before effect cleanup", async () => {
    const oldIdentity = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(oldIdentity.promise)
        .mockResolvedValueOnce(response(200)),
    );
    const tree = render();
    hooks.current!.flushEffects();
    const logout = elements(tree).find(
      (node) => node.props["aria-label"] === "退出当前后台账号",
    )!;
    (logout.props.onClick as () => void)();
    await flush();
    // No rerender/effect cleanup has run yet; the live identity reference must fence this success.
    oldIdentity.resolve(response(200, user));
    await flush();
    const next = render();
    expect(values.has(tokenKey)).toBe(false);
    expect(JSON.stringify(next)).not.toContain("测试运营");
    expect(elements(next).some((node) => node.type === BrowserLogin)).toBe(
      true,
    );
  });

  it("does not refill an old name/organization after a new identity is accepted", async () => {
    const oldIdentity = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(oldIdentity.promise)
        .mockResolvedValueOnce(response(200)),
    );
    const first = render();
    hooks.current!.flushEffects();
    const logout = elements(first).find(
      (node) => node.props["aria-label"] === "退出当前后台账号",
    )!;
    (logout.props.onClick as () => void)();
    await flush();
    const login = elements(render()).find(
      (node) => node.type === BrowserLogin,
    )!;
    const session: AuthSession = {
      accessToken: "staff-b",
      expiresAt: "2099-01-01T00:00:00.000Z",
      user: {
        ...user,
        id: "new-operator",
        displayName: "新运营",
        memberships: [{ organizationId: "org-new", role: "OPERATOR" }],
      },
    };
    (login.props.onSession as (value: AuthSession) => void)(session);
    oldIdentity.resolve(response(200, user));
    await flush();
    const next = render();
    expect(values.get(tokenKey)).toBe("staff-b");
    expect(JSON.stringify(next)).toContain("新运营");
    expect(JSON.stringify(next)).not.toContain("测试运营");
    expect(JSON.stringify(next)).not.toContain('"organizationId":"org-test"');
  });
});

describe("standalone admin login home", () => {
  it("redirects anonymous visits to a fixed login path without mounting a workbench", () => {
    values.clear();
    browserUrl = new URL(
      "https://admin.example.test/?returnUrl=https://outside.example.test/#technicians",
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const tree = render();
    hooks.current!.flushEffects();
    expect(elements(tree).some((node) => node.type === BrowserLogin)).toBe(
      true,
    );
    expect(JSON.stringify(tree)).not.toContain('"className":"app-shell"');
    expect(JSON.stringify(tree)).not.toContain("经营概览");
    expect(browserUrl.href).toBe("https://admin.example.test/login");
    expect(document.title).toContain("管理后台登录");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not trust a stored token or mount business pages before identity validation", async () => {
    browserUrl = new URL("https://admin.example.test/login");
    const identity = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(identity.promise);
    vi.stubGlobal("fetch", fetcher);
    const pending = render();
    hooks.current!.flushEffects();
    expect(JSON.stringify(pending)).toContain("正在验证登录状态");
    expect(JSON.stringify(pending)).not.toContain('"className":"app-shell"');
    expect(browserUrl.pathname).toBe("/login");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ cache: "no-store" });
    expect(fetcher.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    identity.resolve(response(200, user));
    await flush();
    const tree = render();
    hooks.current!.flushEffects();
    expect(JSON.stringify(tree)).toContain('"className":"app-shell"');
    expect(browserUrl.pathname).toBe("/");
    expect(document.title).toContain("运营中心");
  });

  it("opens the dashboard after password authentication instead of the security workspace", () => {
    values.clear();
    browserUrl = new URL("https://admin.example.test/login");
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const login = elements(render()).find(
      (node) => node.type === BrowserLogin,
    )!;
    hooks.current!.flushEffects();
    (login.props.onSession as (session: AuthSession) => void)({
      accessToken: "staff-new",
      expiresAt: "2099-01-01T00:00:00.000Z",
      user,
    });
    const tree = render();
    hooks.current!.flushEffects();
    expect(browserUrl.pathname).toBe("/");
    expect(JSON.stringify(tree)).toContain("运营中心");
    const dashboard = elements(tree).find(
      (node) =>
        typeof node.type === "function" && node.type.name === "Dashboard",
    );
    expect(dashboard?.props.organizationId).toBe("org-test");
    expect(elements(tree).some((node) => node.type === BrowserLogin)).toBe(
      false,
    );
  });

  it("keeps a temporary verification error out of the workbench and supports a read-only retry", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("isolated network failure"))
      .mockResolvedValueOnce(response(200, user));
    vi.stubGlobal("fetch", fetcher);
    render();
    hooks.current!.flushEffects();
    await flush();
    const failed = render();
    expect(values.get(tokenKey)).toBe("staff-a");
    expect(JSON.stringify(failed)).not.toContain('"className":"app-shell"');
    expect(JSON.stringify(failed)).toContain("登录状态暂时无法验证");
    const retry = elements(failed).find(
      (node) =>
        node.type === "button" && node.props.children === "重新验证登录状态",
    )!;
    (retry.props.onClick as () => void)();
    render();
    hooks.current!.flushEffects();
    await flush();
    expect(JSON.stringify(render())).toContain('"className":"app-shell"');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(
      true,
    );
  });

  it("does not show staff tools to an authenticated customer without a management membership", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(200, {
          ...user,
          memberships: [{ organizationId: "org-test", role: "CUSTOMER" }],
        }),
      ),
    );
    render();
    hooks.current!.flushEffects();
    await flush();
    const tree = render();
    expect(JSON.stringify(tree)).toContain("当前账号没有后台管理权限");
    expect(JSON.stringify(tree)).not.toContain('"className":"app-shell"');
    expect(JSON.stringify(tree)).not.toContain("技师管理");
  });

  it("returns successful logout to the login page without retaining staff navigation", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(200, user))
        .mockResolvedValueOnce(response(200)),
    );
    render();
    hooks.current!.flushEffects();
    await flush();
    const tree = render();
    hooks.current!.flushEffects();
    const logout = elements(tree).find(
      (node) => node.props["aria-label"] === "退出当前后台账号",
    )!;
    (logout.props.onClick as () => void)();
    await flush();
    const next = render();
    hooks.current!.flushEffects();
    expect(browserUrl.pathname).toBe("/login");
    expect(values.has(tokenKey)).toBe(false);
    expect(elements(next).some((node) => node.type === BrowserLogin)).toBe(
      true,
    );
  });
});
