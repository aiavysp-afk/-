import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@zydj/contracts";
import { BrowserLogin, StaffPasswordCredentialsFields } from "./browser-login";
import { StaffFirstPasswordSetup } from "./staff-first-password-setup";
import { createHookRenderer } from "./test-hook-renderer";

const hooks = vi.hoisted(() => ({
  current: null as ReturnType<typeof createHookRenderer> | null,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => hooks.current!.useState(initial),
    useMemo: (...args: Parameters<typeof actual.useMemo>) =>
      hooks.current!.useMemo(...args),
    useRef: (...args: Parameters<typeof actual.useRef>) =>
      hooks.current!.useRef(...args),
    useEffect: (...args: Parameters<typeof actual.useEffect>) =>
      hooks.current!.useEffect(args[0], args[1] ?? []),
  };
});
type Node = { type: unknown; props: Record<string, any> };
const onSession = vi.fn();
const session: AuthSession = {
  accessToken: "synthetic-new-browser-session",
  expiresAt: "2099-01-01T00:00:00.000Z",
  user: {
    id: "existing-staff",
    displayName: "原工作人员",
    phoneVerified: true,
    memberships: [{ organizationId: "test-org", role: "OPERATOR" }],
  },
};
const challenge = {
  challengeId: "11111111-1111-4111-8111-111111111111",
  challengeSecret: "s".repeat(43),
  maskedPhone: "138****8000",
  expiresAt: "2099-01-01T00:00:00.000Z",
  retryAfterSeconds: 60,
};
const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200 });
const flush = async () => {
  for (let index = 0; index < 60; index++) await Promise.resolve();
};
function render() {
  return hooks.current!.render(() => BrowserLogin({ onSession }));
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
function button(label: string) {
  const found = nodes(render()).find(
    (node) => node.type === "button" && text(node) === label,
  );
  if (!found) throw Error(`Missing fixture button ${label}`);
  return found;
}
function tab(label: string) {
  const found = nodes(render()).find(
    (node) => node.props.role === "tab" && text(node).includes(label),
  );
  if (!found) throw Error(`Missing fixture tab ${label}`);
  return found;
}
function setup() {
  const found = nodes(render()).find(
    (node) => node.type === StaffFirstPasswordSetup,
  );
  if (!found) throw Error("Missing first setup flow");
  return found;
}
function fillPassword() {
  nodes(render())
    .find((node) => node.type === StaffPasswordCredentialsFields)!
    .props.onAccountChange("admin");
  nodes(render())
    .find((node) => node.type === StaffPasswordCredentialsFields)!
    .props.onPasswordChange("synthetic-password-42");
}
function submitPassword() {
  nodes(render())
    .find(
      (node) =>
        node.type === "form" && text(node).includes("验证密码并发送短信"),
    )!
    .props.onSubmit({ preventDefault() {} });
}
async function ready(setupEnabled: unknown = true) {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ enabled: true, provider: "wechat" }))
    .mockResolvedValueOnce(
      json({ enabled: true, smsEnabled: true, setupEnabled }),
    );
  vi.stubGlobal("fetch", fetcher);
  render();
  hooks.current!.flushEffects();
  await flush();
  return fetcher;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T00:00:00.000Z"));
  hooks.current = createHookRenderer();
  onSession.mockReset();
});
afterEach(() => {
  hooks.current?.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("password/SMS default and explicit first-use flow wiring", () => {
  it("defaults to password/SMS, leaves WeChat optional, and does not send SMS when opening first setup", async () => {
    const fetcher = await ready();
    expect(tab("账号密码登录").props["aria-selected"]).toBe(true);
    expect(tab("微信登录").props["aria-selected"]).toBe(false);
    expect(text(render())).not.toContain("首次使用请先完成微信登录");
    button("首次设置账号密码").props.onClick();
    expect(setup().props.enabled).toBe(true);
    expect(setup().props.isParentCurrent()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    setup().props.onCancel();
    expect(
      nodes(render()).some((node) => node.type === StaffFirstPasswordSetup),
    ).toBe(false);
    tab("微信登录").props.onClick();
    expect(button("发起微信后台登录")).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not expose or invoke first setup when setupEnabled is false while ordinary password login still works", async () => {
    const fetcher = await ready(false);
    expect(button("首次设置账号密码").props.disabled).toBe(true);
    button("首次设置账号密码").props.onClick();
    expect(
      nodes(render()).some((node) => node.type === StaffFirstPasswordSetup),
    ).toBe(false);
    expect(text(render())).toContain("首次设置账号密码尚未启用");
    fillPassword();
    fetcher.mockResolvedValueOnce(json(challenge));
    submitPassword();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]?.[0]).toContain("/auth/staff-password/login");
    expect(onSession).not.toHaveBeenCalled();
  });

  it.each([null, "false", 1])(
    "fails the first-setup gate closed for malformed flag %j",
    async (flag) => {
      const fetcher = await ready(flag);
      expect(button("首次设置账号密码").props.disabled).toBe(true);
      button("首次设置账号密码").props.onClick();
      expect(
        nodes(render()).some((node) => node.type === StaffFirstPasswordSetup),
      ).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("invalidates the old setup scope synchronously when changing methods, including returning to setup", async () => {
    const fetcher = await ready();
    button("首次设置账号密码").props.onClick();
    const old = setup().props;
    tab("微信登录").props.onClick();
    expect(old.isParentCurrent()).toBe(false);
    tab("账号密码登录").props.onClick();
    button("首次设置账号密码").props.onClick();
    expect(setup().props.isParentCurrent()).toBe(true);
    expect(old.isParentCurrent()).toBe(false);
    fetcher.mockResolvedValueOnce(json({ revoked: true }));
    await old.onSession(session, old.isParentCurrent);
    await flush();
    expect(onSession).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]?.[0]).toContain("/auth/logout");
    expect(fetcher.mock.calls[2]?.[1].headers.Authorization).toBe(
      `Bearer ${session.accessToken}`,
    );
  });

  it("preserves a manual SMS retry deadline when returning from setup to ordinary login", async () => {
    const fetcher = await ready();
    button("首次设置账号密码").props.onClick();
    const flow = setup().props;
    const deadline = Date.now() + 60_000;
    flow.retryDeadline.current = deadline;
    flow.onCooldown(deadline);
    flow.onCancel();
    render();
    hooks.current!.flushEffects();
    fillPassword();
    expect(button("验证密码并发送短信").props.disabled).toBe(true);
    submitPassword();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(json(challenge));
    submitPassword();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps the existing password-plus-SMS confirmation and existing session delivery path", async () => {
    const fetcher = await ready();
    fillPassword();
    fetcher.mockResolvedValueOnce(json(challenge));
    submitPassword();
    await flush();
    expect(text(render())).toContain(challenge.maskedPhone);
    expect(onSession).not.toHaveBeenCalled();
    nodes(render())
      .find(
        (node) =>
          node.type === "input" && node.props.autoComplete === "one-time-code",
      )!
      .props.onChange({ target: { value: "000001" } });
    fetcher
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ enabled: false }));
    nodes(render())
      .find(
        (node) => node.type === "form" && text(node).includes("验证并登录"),
      )!
      .props.onSubmit({ preventDefault() {} });
    await flush();
    expect(onSession).toHaveBeenCalledWith(session);
    expect(fetcher.mock.calls[3]?.[0]).toContain(
      "/auth/staff-password/confirm",
    );
    expect(fetcher.mock.calls[4]?.[0]).toContain(
      "/auth/trusted-devices/config",
    );
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).includes("browser-login/create"),
      ),
    ).toBe(false);
  });
});
