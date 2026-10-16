import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { AuthSession } from "@zydj/contracts";
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
const user = {
  id: "synthetic-operator",
  displayName: "测试运营",
  phoneVerified: true,
  memberships: [{ organizationId: "org-test", role: "OPERATOR" }],
};
const tokenKey = "zydj.admin.access-token";
let values: Map<string, string>;
beforeEach(() => {
  hooks.current = createHookRenderer();
  values = new Map([[tokenKey, "staff-a"]]);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("localStorage", { removeItem: vi.fn() });
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
  it("removes an expired runtime session and exposes the existing WeChat login entry", async () => {
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
    expect(values.has(tokenKey)).toBe(false);
    expect(JSON.stringify(tree)).not.toContain("已登录 · 账户安全");
    expect(JSON.stringify(tree)).not.toContain("测试运营");
    expect(elements(tree).some((node) => node.type === BrowserLogin)).toBe(
      true,
    );
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
