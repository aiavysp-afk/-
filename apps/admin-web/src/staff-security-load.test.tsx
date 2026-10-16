import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRenderer } from "./test-hook-renderer";
import { StaffSecurity, StaffPasswordSettingsForm } from "./staff-security";

const hooks = vi.hoisted(() => ({
  current: null as ReturnType<typeof createHookRenderer> | null,
  updates: 0,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const [value, setValue] = hooks.current!.useState(initial);
      return [
        value,
        (next: unknown) => {
          hooks.updates++;
          setValue(next);
        },
      ];
    },
    useMemo: (...args: Parameters<typeof actual.useMemo>) =>
      hooks.current!.useMemo(...args),
    useRef: (...args: Parameters<typeof actual.useRef>) =>
      hooks.current!.useRef(...args),
    useEffect: (...args: Parameters<typeof actual.useEffect>) =>
      hooks.current!.useEffect(args[0], args[1] ?? []),
  };
});
vi.mock("./authenticated-fetch", () => ({
  authenticatedFetch: (
    _token: string,
    url: RequestInfo | URL,
    init?: RequestInit,
  ) => fetch(url, init),
}));

type Node = { type: unknown; props: Record<string, any> };
type Pending = {
  path: string;
  resolved: boolean;
  resolve: (response: Response) => void;
};
let pending: Pending[];
let renderedToken: string | undefined;
const until = new Date(Date.now() + 240_000).toISOString();
const password = {
  configured: true,
  maskedAccount: "138****8000",
  loginAlias: "test_operator",
  changedAt: null,
};
const passwordFeature = { enabled: true, smsEnabled: true };
const trust = { enabled: true, maxDays: 7 };
const device = {
  id: "test-device",
  label: "测试私人电脑",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const flush = async () => {
  for (let index = 0; index < 40; index++) await Promise.resolve();
};
function render(token = "test-session-a") {
  // Match the production wrapper's token key: replace the complete identity scope.
  if (renderedToken !== undefined && renderedToken !== token) {
    hooks.current!.unmount();
    hooks.current = createHookRenderer();
  }
  renderedToken = token;
  return hooks.current!.render(() => {
    const scope = StaffSecurity({
      token,
      verifiedUntil: until,
    }) as unknown as Node;
    return (scope.type as (props: Record<string, any>) => Node)(scope.props);
  });
}
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
function reply(path: string, data: unknown, status = 200, occurrence = 0) {
  const item = pending.filter((item) => item.path === path && !item.resolved)[
    occurrence
  ];
  if (!item) throw Error(`Missing synthetic request ${path}`);
  item.resolved = true;
  item.resolve(
    new Response(
      JSON.stringify(
        status < 400 ? { data } : { message: "测试设备服务暂时不可用" },
      ),
      { status },
    ),
  );
}
async function resolveCore() {
  reply("/auth/staff-password", password);
  reply("/auth/staff-password/config", passwordFeature);
  reply("/auth/trusted-devices/config", trust);
  await flush();
}
function refresh() {
  nodes(render())
    .find(
      (node) =>
        node.type === "button" && text(node) === "重新读取密码与设备配置",
    )!
    .props.onClick();
}
beforeEach(() => {
  hooks.current = createHookRenderer();
  hooks.updates = 0;
  pending = [];
  renderedToken = undefined;
  vi.stubGlobal("window", {
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
    confirm: vi.fn(() => true),
  });
  vi.stubGlobal(
    "fetch",
    (url: string) =>
      new Promise<Response>((resolve) =>
        pending.push({
          path: new URL(url).pathname.replace(/^\/v1/, ""),
          resolved: false,
          resolve,
        }),
      ),
  );
});
afterEach(() => {
  hooks.current?.unmount();
  vi.unstubAllGlobals();
});

describe("self password state stays independent of optional trusted devices", () => {
  it("shows successful password status while the optional device list is still pending, then isolates its 503", async () => {
    render();
    hooks.current!.flushEffects();
    await resolveCore();
    expect(text(render())).toContain("test_operator");
    reply("/auth/trusted-devices", {}, 503);
    await flush();
    const tree = render();
    expect(text(tree)).toContain("test_operator");
    expect(text(tree)).not.toContain("密码配置尚未读取成功");
    expect(text(tree)).not.toContain("账号密码短信登录尚未开放");
    expect(text(tree)).toContain("设备列表读取失败");
    expect(
      nodes(tree).find((node) => node.type === StaffPasswordSettingsForm)!.props
        .disabled,
    ).toBe(false);
  });

  it("keeps the last successful password and device snapshots during a refresh and after device failure", async () => {
    render();
    hooks.current!.flushEffects();
    await resolveCore();
    reply("/auth/trusted-devices", [device]);
    await flush();
    refresh();
    expect(text(render())).toContain("test_operator");
    expect(text(render())).toContain("测试私人电脑");
    await resolveCore();
    reply("/auth/trusted-devices", {}, 503);
    await flush();
    const tree = render();
    expect(text(tree)).toContain("test_operator");
    expect(text(tree)).toContain("测试私人电脑");
    expect(text(tree)).toContain("上次成功读取");
    expect(
      nodes(tree).find(
        (node) => node.type === "button" && text(node) === "撤销信任",
      )!.props.disabled,
    ).toBe(true);
  });

  it("does not let trust configuration failure hide successful self-password configuration", async () => {
    render();
    hooks.current!.flushEffects();
    reply("/auth/staff-password", password);
    reply("/auth/staff-password/config", passwordFeature);
    reply("/auth/trusted-devices/config", {}, 503);
    reply("/auth/trusted-devices", []);
    await flush();
    const tree = render();
    expect(text(tree)).toContain("test_operator");
    expect(text(tree)).toContain("信任设备配置读取失败");
    expect(
      nodes(tree).find((node) => node.type === StaffPasswordSettingsForm)!.props
        .disabled,
    ).toBe(false);
  });

  it.each([200, 503])(
    "ignores a late optional-device %s after leaving the identity scope",
    async (status) => {
      render();
      hooks.current!.flushEffects();
      await resolveCore();
      hooks.current!.unmount();
      const updates = hooks.updates;
      reply("/auth/trusted-devices", [device], status);
      await flush();
      expect(hooks.updates).toBe(updates);
      expect(pending).toHaveLength(4);
    },
  );

  it.each([200, 503])(
    "does not refill a new identity from a previous device %s",
    async (status) => {
      render();
      hooks.current!.flushEffects();
      await resolveCore();
      render("test-session-b");
      hooks.current!.flushEffects();
      reply("/auth/staff-password", {
        ...password,
        loginAlias: "new_operator",
      });
      reply("/auth/staff-password/config", passwordFeature);
      reply("/auth/trusted-devices/config", trust);
      reply(
        "/auth/trusted-devices",
        [{ ...device, id: "new-device", label: "新身份电脑" }],
        200,
        1,
      );
      await flush();
      const updates = hooks.updates;
      reply("/auth/trusted-devices", [device], status);
      await flush();
      const tree = render("test-session-b");
      expect(hooks.updates).toBe(updates);
      expect(text(tree)).toContain("new_operator");
      expect(text(tree)).toContain("新身份电脑");
      expect(text(tree)).not.toContain("test_operator");
      expect(text(tree)).not.toContain("测试私人电脑");
      expect(text(tree)).not.toContain("设备列表读取失败");
    },
  );

  it("ignores a stale optional-device failure after a later refresh has succeeded", async () => {
    render();
    hooks.current!.flushEffects();
    await resolveCore();
    refresh();
    await resolveCore();
    reply(
      "/auth/trusted-devices",
      [{ ...device, label: "最新读取设备" }],
      200,
      1,
    );
    await flush();
    const updates = hooks.updates;
    reply("/auth/trusted-devices", {}, 503);
    await flush();
    const tree = render();
    expect(hooks.updates).toBe(updates);
    expect(text(tree)).toContain("最新读取设备");
    expect(text(tree)).not.toContain("设备列表读取失败");
  });

  it("retires an abandoned device read after password save fails, then permits an explicit fresh read", async () => {
    render();
    hooks.current!.flushEffects();
    await resolveCore();
    const form = nodes(render()).find(
      (node) => node.type === StaffPasswordSettingsForm,
    )!;
    form.props.onChange({
      loginAlias: "test_operator",
      password: "synthetic-password-42",
      confirmation: "synthetic-password-42",
    });
    nodes(render())
      .find((node) => node.type === StaffPasswordSettingsForm)!
      .props.onSubmit();
    reply("/auth/staff-password", {}, 503);
    await flush();
    let tree = render();
    expect(text(tree)).not.toContain("正在读取设备列表");
    expect(text(tree)).toContain("上次设备列表读取已中断");
    expect(
      nodes(tree).find(
        (node) =>
          node.type === "button" && text(node) === "重新读取密码与设备配置",
      )!.props.disabled,
    ).toBe(false);
    const updates = hooks.updates;
    reply("/auth/trusted-devices", [device]);
    await flush();
    expect(hooks.updates).toBe(updates);
    expect(text(render())).not.toContain("测试私人电脑");
    refresh();
    await resolveCore();
    reply("/auth/trusted-devices", [device]);
    await flush();
    tree = render();
    expect(text(tree)).toContain("测试私人电脑");
    expect(text(tree)).not.toContain("读取已中断");
    expect(text(tree)).not.toContain("设备列表读取失败");
  });

  it("rejects a previously enabled password handler while a fresh password read is pending", async () => {
    render();
    hooks.current!.flushEffects();
    await resolveCore();
    reply("/auth/trusted-devices", []);
    await flush();
    nodes(render())
      .find((node) => node.type === StaffPasswordSettingsForm)!
      .props.onChange({
        loginAlias: "test_operator",
        password: "synthetic-password-42",
        confirmation: "synthetic-password-42",
      });
    const oldSubmit = nodes(render()).find(
      (node) => node.type === StaffPasswordSettingsForm,
    )!.props.onSubmit;
    refresh();
    const requests = pending.length;
    oldSubmit();
    await flush();
    expect(pending).toHaveLength(requests);
  });

  it("rejects a previously enabled revoke handler while its device snapshot is being refreshed", async () => {
    render();
    hooks.current!.flushEffects();
    await resolveCore();
    reply("/auth/trusted-devices", [device]);
    await flush();
    const oldRevoke = nodes(render()).find(
      (node) => node.type === "button" && text(node) === "撤销信任",
    )!.props.onClick;
    refresh();
    const requests = pending.length;
    oldRevoke();
    await flush();
    expect(pending).toHaveLength(requests);
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("rejects a previously enabled registration handler while trust configuration is being refreshed", async () => {
    render();
    hooks.current!.flushEffects();
    await resolveCore();
    reply("/auth/trusted-devices", []);
    await flush();
    nodes(render())
      .find((node) => node.type === "input" && node.props.type === "checkbox")!
      .props.onChange({ target: { checked: true } });
    const oldRegister = nodes(render()).find(
      (node) => node.type === "button" && text(node) === "信任本设备 7 天",
    )!.props.onClick;
    refresh();
    const requests = pending.length;
    oldRegister();
    await flush();
    expect(pending).toHaveLength(requests);
  });

  it("does not revive an old revoke handler after the latest device read has failed", async () => {
    render();
    hooks.current!.flushEffects();
    await resolveCore();
    reply("/auth/trusted-devices", [device]);
    await flush();
    const oldRevoke = nodes(render()).find(
      (node) => node.type === "button" && text(node) === "撤销信任",
    )!.props.onClick;
    refresh();
    await resolveCore();
    reply("/auth/trusted-devices", {}, 503);
    await flush();
    const requests = pending.length;
    oldRevoke();
    await flush();
    expect(pending).toHaveLength(requests);
    expect(window.confirm).not.toHaveBeenCalled();
  });
});
