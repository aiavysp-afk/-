import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise actual component request callbacks without a browser, a DOM or any
// authentication service. Every response and code below is an isolated fixture.
const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  pendingEffects: [] as Array<() => void>,
  effects: new Map<number, { deps: unknown[]; cleanup?: () => void }>(),
  updates: 0,
}));
vi.mock("react", () => ({
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.updates++;
        hooks.slots[index] =
          typeof next === "function" ? next(hooks.slots[index]) : next;
      },
    ];
  },
  useMemo(factory: () => unknown, deps: unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as
      | { deps: unknown[]; value: unknown }
      | undefined;
    if (!previous || deps.some((value, i) => value !== previous.deps[i]))
      hooks.slots[index] = { deps, value: factory() };
    return (hooks.slots[index] as { value: unknown }).value;
  },
  useEffect(effect: () => (() => void) | void, deps: unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.effects.get(index);
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
      hooks.pendingEffects.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        hooks.effects.set(index, { deps, ...(cleanup ? { cleanup } : {}) });
      });
    }
  },
}));
vi.mock("react/jsx-runtime", () => ({
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
  Fragment: "fragment",
}));
vi.mock("./browser-login", () => ({
  BrowserLogin: function BrowserLogin() {
    return null;
  },
}));
vi.mock("./staff-security", () => ({
  StaffSecurity: function StaffSecurity() {
    return null;
  },
}));
vi.mock("./authenticated-fetch", () => ({
  authenticatedFetch: (
    _token: string,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => fetch(input, init),
}));

import { SecurityWorkspace } from "./security";
import { StaffSecurity } from "./staff-security";

type Node = { type: unknown; props: Record<string, any> };
type Pending = { url: string; resolve: (response: Response) => void };
const pending: Pending[] = [];
const base = {
  enabled: true,
  enrollmentPending: false,
  lockedUntil: null,
  verifiedUntil: null as string | null,
  required: true,
  staffEligible: true,
};
const operator = {
  memberships: [{ organizationId: "isolated-org", role: "OPERATOR" }],
};
const admin = {
  memberships: [{ organizationId: "isolated-org", role: "ADMIN" }],
};
const flush = async () => {
  for (let index = 0; index < 40; index++) await Promise.resolve();
};
const logout = vi.fn<() => Promise<void>>(async () => {});
let renderedToken: string | undefined;
function render(token = "isolated-session-a") {
  // Mirror React's key remount on identity replacement, without a DOM.
  if (renderedToken !== undefined && renderedToken !== token) {
    for (const effect of hooks.effects.values()) effect.cleanup?.();
    hooks.slots = [];
    hooks.effects.clear();
    hooks.pendingEffects = [];
  }
  renderedToken = token;
  hooks.cursor = 0;
  const scope = SecurityWorkspace({
    token,
    onLogout: logout,
    onSession: () => {},
  }) as unknown as Node;
  const tree = (scope.type as (props: Record<string, any>) => unknown)(
    scope.props,
  ) as Node;
  const effects = hooks.pendingEffects.splice(0);
  effects.forEach((effect) => effect());
  return tree;
}
function nodes(value: unknown): Node[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const node = value as Node;
  return [node, ...nodes(node.props?.children)];
}
function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  return text((value as Node).props?.children);
}
function button(tree: Node, label: string) {
  const result = nodes(tree).find(
    (node) => node.type === "button" && text(node) === label,
  );
  if (!result) throw Error(`Missing fixture button ${label}`);
  return result;
}
function verification(tree: Node) {
  return nodes(tree).find((node) => node.type === StaffSecurity)?.props
    .verifiedUntil;
}
function reply(index: number, data: unknown, status = 200) {
  const request = pending[index];
  if (!request) throw Error(`Missing fixture request ${index}`);
  request.resolve({
    ok: status < 400,
    status,
    json: async () =>
      status < 400
        ? { data }
        : {
            message:
              status === 401 ? "需要重新验证安全凭证" : "恢复队列暂时不可用",
          },
  } as Response);
}
beforeEach(() => {
  hooks.cursor = 0;
  hooks.slots = [];
  hooks.pendingEffects = [];
  hooks.effects.clear();
  hooks.updates = 0;
  pending.length = 0;
  renderedToken = undefined;
  logout.mockReset();
  logout.mockResolvedValue();
  vi.stubGlobal(
    "fetch",
    (url: string) =>
      new Promise<Response>((resolve) => pending.push({ url, resolve })),
  );
});
afterEach(() => {
  for (const effect of hooks.effects.values()) effect.cleanup?.();
  vi.unstubAllGlobals();
});

describe("account security actual async state", () => {
  it("explains first-display-only pending enrollment recovery without requesting another secret", async () => {
    render();
    reply(0, { ...base, enabled: false, enrollmentPending: true });
    reply(1, operator);
    await flush();
    const tree = render();
    expect(text(tree)).toContain("若已录入验证器");
    expect(text(tree)).toContain("同一登录会话");
    expect(text(tree)).toContain("自创建起 10 分钟");
    expect(text(tree)).toContain("新登录会话创建后 5 分钟内");
    expect(text(tree)).toContain("不会再次显示密钥");
    expect(button(tree, "确认绑定").props.disabled).toBe(true);
    expect(button(tree, "刷新安全状态")).toBeDefined();
    expect(button(tree, "注销当前会话")).toBeDefined();
    expect(pending).toHaveLength(2);
    expect(text(tree)).not.toContain("开始绑定验证器");
  });

  it("does not let an old refresh overwrite a newly verified TOTP session", async () => {
    render();
    reply(0, base);
    reply(1, operator);
    await flush();
    let tree = render();
    nodes(tree)
      .find((node) => node.type === "input")!
      .props.onChange({ target: { value: "000001" } });
    tree = render();
    const verify = button(tree, "验证当前会话").props.onClick;
    button(tree, "刷新安全状态").props.onClick();
    verify();
    reply(4, {});
    await flush();
    const until = new Date(Date.now() + 240_000).toISOString();
    reply(5, { ...base, verifiedUntil: until });
    reply(6, operator);
    await flush();
    expect(verification(render())).toBe(until);
    reply(2, base);
    reply(3, operator);
    await flush();
    expect(verification(render())).toBe(until);
  });

  it("keeps successful self MFA status when the optional recovery queue fails", async () => {
    render();
    const until = new Date(Date.now() + 240_000).toISOString();
    reply(0, { ...base, verifiedUntil: until });
    reply(1, admin);
    await flush();
    reply(2, {}, 503);
    await flush();
    const tree = render();
    expect(verification(tree)).toBe(until);
    expect(text(tree)).toContain("恢复队列");
    expect(text(tree)).not.toContain("当前没有待复核的恢复申请");
  });

  it("shows a queue MFA 401 without confusing it with an expired browser identity", async () => {
    render();
    const until = new Date(Date.now() + 240_000).toISOString();
    reply(0, { ...base, verifiedUntil: until });
    reply(1, admin);
    await flush();
    reply(2, {}, 401);
    await flush();
    expect(verification(render())).toBe(until);
    expect(text(render())).toContain("需要重新验证安全凭证");
    expect(text(render())).not.toContain("当前没有待复核的恢复申请");
  });

  it("invalidates every result and finally update after unmount", async () => {
    render();
    for (const effect of hooks.effects.values()) effect.cleanup?.();
    const updates = hooks.updates;
    reply(0, base);
    reply(1, operator);
    await flush();
    expect(hooks.updates).toBe(updates);
  });
  it("keeps a self verified state usable while the optional queue is still loading", async () => {
    render();
    const until = new Date(Date.now() + 240_000).toISOString();
    reply(0, { ...base, verifiedUntil: until });
    reply(1, admin);
    await flush();
    const tree = render();
    expect(verification(tree)).toBe(until);
    expect(button(tree, "刷新安全状态").props.disabled).toBe(false);
    expect(text(tree)).toContain("正在读取恢复队列");
    expect(text(tree)).not.toContain("当前没有待复核的恢复申请");
  });
  it("shows queue loading instead of a false empty queue while refreshing", async () => {
    render();
    const until = new Date(Date.now() + 240_000).toISOString();
    reply(0, { ...base, verifiedUntil: until });
    reply(1, admin);
    await flush();
    reply(2, []);
    await flush();
    button(render(), "刷新安全状态").props.onClick();
    const tree = render();
    expect(text(tree)).toContain("正在读取恢复队列");
    expect(text(tree)).not.toContain("当前没有待复核的恢复申请");
  });
  it("ignores a previous queue failure and finally while a newer refresh is pending", async () => {
    render();
    const until = new Date(Date.now() + 240_000).toISOString();
    reply(0, { ...base, verifiedUntil: until });
    reply(1, admin);
    await flush();
    button(render(), "刷新安全状态").props.onClick();
    reply(2, {}, 503);
    await flush();
    const loading = render();
    expect(button(loading, "刷新安全状态").props.disabled).toBe(true);
    expect(text(loading)).not.toContain("恢复队列暂时不可用");
    reply(3, { ...base, verifiedUntil: until });
    reply(4, operator);
    await flush();
    expect(verification(render())).toBe(until);
    expect(text(render())).not.toContain("恢复队列暂时不可用");
  });
  it("ignores a former identity response even after switching back to its token", async () => {
    render();
    render("isolated-session-b");
    render();
    const until = new Date(Date.now() + 240_000).toISOString();
    reply(4, { ...base, verifiedUntil: until });
    reply(5, operator);
    await flush();
    expect(verification(render())).toBe(until);
    reply(0, base);
    reply(1, operator);
    await flush();
    expect(verification(render())).toBe(until);
    reply(2, {}, 401);
    reply(3, operator);
    await flush();
    expect(verification(render())).toBe(until);
  });
  it("never starts a follow-up refresh for enrollment completed after unmount", async () => {
    render();
    reply(0, { ...base, enabled: false });
    reply(1, operator);
    await flush();
    button(
      render(),
      "开始绑定验证器（需五分钟内的新微信登录）",
    ).props.onClick();
    for (const effect of hooks.effects.values()) effect.cleanup?.();
    const updates = hooks.updates;
    reply(2, {
      secret: "isolated-not-a-real-provisioning-value",
      issuer: "Fixture",
      accountName: "Fixture",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    await flush();
    expect(hooks.updates).toBe(updates);
    expect(pending).toHaveLength(3);
  });

  it("preserves current enrollment after a rejected activation code", async () => {
    render();
    reply(0, { ...base, enabled: false });
    reply(1, operator);
    await flush();
    button(render(), "开始绑定验证器（需五分钟内的新微信登录）").props.onClick();
    reply(2, {
      secret: "isolated-not-a-real-provisioning-value",
      issuer: "Fixture",
      accountName: "Fixture",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    await flush();
    reply(3, { ...base, enabled: false, enrollmentPending: true });
    reply(4, operator);
    await flush();
    let tree = render();
    nodes(tree).find((node) => node.type === "input")!.props.onChange({
      target: { value: "000001" },
    });
    button(render(), "确认绑定").props.onClick();
    reply(5, {}, 401);
    await flush();
    tree = render();
    expect(text(tree)).toContain("需要重新验证安全凭证");
    expect(text(tree)).toContain("仅本次显示");
    expect(text(tree)).toContain("待激活");
    expect(nodes(tree).find((node) => node.type === "input")!.props.value).toBe("");
    expect(button(tree, "确认绑定").props.disabled).toBe(true);
  });

  it("never writes a late logout failure after its identity is unmounted", async () => {
    let rejectLogout!: (error: Error) => void;
    logout.mockImplementation(
      () => new Promise<void>((_resolve, reject) => { rejectLogout = reject; }),
    );
    render();
    reply(0, base);
    reply(1, operator);
    await flush();
    button(render(), "注销当前会话").props.onClick();
    for (const effect of hooks.effects.values()) effect.cleanup?.();
    const updates = hooks.updates;
    rejectLogout(Error("isolated logout error"));
    await flush();
    expect(hooks.updates).toBe(updates);
  });
});
