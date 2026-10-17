import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@zydj/contracts";
import { createHookRenderer } from "./test-hook-renderer";
import { StaffFirstPasswordSetup } from "./staff-first-password-setup";
import { deliverBrowserSession } from "./login-state";

const hooks = vi.hoisted(() => ({
  current: null as ReturnType<typeof createHookRenderer> | null,
  updates: 0,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const [value, set] = hooks.current!.useState(initial);
      return [
        value,
        (next: unknown) => {
          hooks.updates++;
          set(next);
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
type Node = { type: unknown; props: Record<string, any> };
const challenge = {
  challengeId: "11111111-1111-4111-8111-111111111111",
  challengeSecret: "s".repeat(43),
  maskedPhone: "138****8000",
  expiresAt: "2026-01-01T00:00:00.000Z",
  retryAfterSeconds: 60,
};
const session: AuthSession = {
  accessToken: "synthetic-staff-session",
  expiresAt: "2099-01-01T00:00:00.000Z",
  user: {
    id: "authorized-user",
    displayName: "原授权工作人员",
    phoneVerified: true,
    memberships: [{ organizationId: "org-test", role: "OPERATOR" }],
  },
};
let enabled: boolean, parentCurrent: boolean;
let retryDeadline: { current: number };
const request =
  vi.fn<(path: string, body?: unknown, token?: string) => Promise<unknown>>();
const accepted = vi.fn(async () => ({ trusted: false })),
  revoked = vi.fn(async () => {}),
  authenticated = vi.fn(),
  cancel = vi.fn();
const deliver = vi.fn(async (value: AuthSession, isCurrent: () => boolean) =>
  deliverBrowserSession(value, isCurrent, accepted, revoked, authenticated),
);
const flush = async () => {
  for (let index = 0; index < 50; index++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function render() {
  return hooks.current!.render(() =>
    StaffFirstPasswordSetup({
      enabled,
      isParentCurrent: () => parentCurrent,
      retryDeadline,
      request: <T,>(path: string, body?: unknown, token?: string) =>
        request(path, body, token) as Promise<T>,
      onSession: deliver,
      onCancel: cancel,
    }),
  );
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
function input(tree: unknown, label: string) {
  const row = nodes(tree).find(
    (node) => node.type === "label" && text(node) === label,
  );
  const result = nodes(row).find((node) => node.type === "input");
  if (!result) throw Error(`Missing fixture field ${label}`);
  return result;
}
function change(label: string, value: string) {
  input(render(), label).props.onChange({ target: { value } });
}
function form(tree: unknown, label: string) {
  const result = nodes(tree).find(
    (node) => node.type === "form" && text(node).includes(label),
  );
  if (!result) throw Error(`Missing fixture form ${label}`);
  return result;
}
function send() {
  form(render(), "本人已绑定手机号").props.onSubmit({ preventDefault() {} });
}
function confirm() {
  form(render(), "本人确认设置密码并登录").props.onSubmit({
    preventDefault() {},
  });
}
async function ready() {
  render();
  hooks.current!.flushEffects();
  change("本人已绑定手机号", "13800138000");
  request.mockResolvedValueOnce(challenge);
  send();
  await flush();
}
function fill() {
  change("短信验证码", "000001");
  change("设置登录用户名", "  Admin_01  ");
  change("设置新密码", "synthetic-password-42");
  change("再次输入新密码", "synthetic-password-42");
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T00:00:00.000Z"));
  hooks.current = createHookRenderer();
  hooks.updates = 0;
  enabled = true;
  parentCurrent = true;
  retryDeadline = { current: 0 };
  request.mockReset();
  accepted.mockReset();
  accepted.mockResolvedValue({ trusted: false });
  revoked.mockClear();
  authenticated.mockReset();
  deliver.mockClear();
  cancel.mockClear();
  vi.stubGlobal("localStorage", {
    setItem: vi.fn(() => {
      throw Error("Credentials must never be persisted");
    }),
  });
  vi.stubGlobal("sessionStorage", {
    setItem: vi.fn(() => {
      throw Error("Credentials must never be persisted");
    }),
  });
});
afterEach(() => {
  hooks.current?.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("first staff password setup requires deliberate human actions", () => {
  it("never requests SMS on open, typing, or elapsed time and makes setup gating explicit", async () => {
    enabled = false;
    render();
    hooks.current!.flushEffects();
    expect(text(render())).toContain("首次设置账号密码尚未启用");
    expect(nodes(render()).some((node) => node.type === "input")).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(request).not.toHaveBeenCalled();
    enabled = true;
    render();
    hooks.current!.flushEffects();
    change("本人已绑定手机号", "13800138000");
    expect(text(render())).toContain(
      "不注册新账号、不重置已有密码、不增加权限",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("submits only the phone after a click, shows neutral delivery copy, and never renders its proof", async () => {
    await ready();
    const tree = render();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]).toEqual([
      "/auth/staff-password/setup/request",
      { phone: "13800138000" },
      undefined,
    ]);
    expect(text(tree)).toContain("若号码符合现有授权账号的首次设置条件");
    expect(text(tree)).toContain("不保证送达");
    expect(text(tree)).toContain(challenge.maskedPhone);
    expect(JSON.stringify(tree)).not.toContain(challenge.challengeSecret);
    expect(JSON.stringify(tree)).not.toContain(challenge.challengeId);
    expect(authenticated).not.toHaveBeenCalled();
  });

  it("requires valid alias, matching long passwords and a manual final confirmation, clearing secrets before waiting", async () => {
    await ready();
    fill();
    expect(request).toHaveBeenCalledTimes(1);
    const pending = deferred<unknown>();
    request.mockReturnValueOnce(pending.promise);
    const final = form(render(), "本人确认设置密码并登录").props.onSubmit;
    final({ preventDefault() {} });
    final({ preventDefault() {} });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({
      challengeId: challenge.challengeId,
      challengeSecret: challenge.challengeSecret,
      code: "000001",
      loginAlias: "admin_01",
      password: "synthetic-password-42",
    });
    for (const node of nodes(render()).filter(
      (node) => node.type === "input" && node.props.type === "password",
    ))
      expect(node.props.value).toBe("");
    pending.resolve(session);
    await flush();
    expect(authenticated).toHaveBeenCalledWith(session);
    expect(accepted).toHaveBeenCalledOnce();
    expect(revoked).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it("does not confirm short or mismatched passwords even when its submit handler is directly invoked", async () => {
    await ready();
    fill();
    change("再次输入新密码", "different-password");
    confirm();
    expect(request).toHaveBeenCalledTimes(1);
    change("设置新密码", "000001");
    change("再次输入新密码", "000001");
    confirm();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retains retryAfterSeconds across phone edits and permits only a manual resend after the countdown", async () => {
    await ready();
    send();
    expect(request).toHaveBeenCalledTimes(1);
    change("本人已绑定手机号", "13900139000");
    send();
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_000);
    send();
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({ ...challenge, maskedPhone: "139****9000" });
    send();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({ phone: "13900139000" });
  });

  it("discards a late challenge after the phone changes, without reviving proof or typed passwords", async () => {
    render();
    hooks.current!.flushEffects();
    change("本人已绑定手机号", "13800138000");
    const pending = deferred<unknown>();
    request.mockReturnValueOnce(pending.promise);
    send();
    change("本人已绑定手机号", "13900139000");
    const updates = hooks.updates;
    pending.resolve(challenge);
    await flush();
    expect(hooks.updates).toBe(updates);
    expect(text(render())).not.toContain(challenge.maskedPhone);
    expect(
      nodes(render()).some(
        (node) =>
          node.type === "input" && node.props.autoComplete === "one-time-code",
      ),
    ).toBe(false);
  });

  it("clears an existing challenge and all password fields when changing the phone", async () => {
    await ready();
    fill();
    change("本人已绑定手机号", "13900139000");
    expect(text(render())).not.toContain(challenge.maskedPhone);
    expect(JSON.stringify(render())).not.toContain("synthetic-password-42");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["unmount", "parent method switch"])(
    "ignores late challenge data after %s",
    async (action) => {
      render();
      hooks.current!.flushEffects();
      change("本人已绑定手机号", "13800138000");
      const pending = deferred<unknown>();
      request.mockReturnValueOnce(pending.promise);
      send();
      if (action === "unmount") hooks.current!.unmount();
      else parentCurrent = false;
      const updates = hooks.updates;
      pending.resolve(challenge);
      await flush();
      expect(hooks.updates).toBe(updates);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["phone change", "unmount", "disabled"])(
    "revokes a successful late session after %s instead of accepting it",
    async (action) => {
      await ready();
      fill();
      const pending = deferred<unknown>();
      request.mockReturnValueOnce(pending.promise);
      confirm();
      if (action === "phone change") change("本人已绑定手机号", "13900139000");
      else if (action === "unmount") hooks.current!.unmount();
      else {
        enabled = false;
        render();
        hooks.current!.flushEffects();
      }
      const updates = hooks.updates;
      pending.resolve(session);
      await flush();
      expect(hooks.updates).toBe(updates);
      expect(revoked).toHaveBeenCalledWith(session);
      expect(authenticated).not.toHaveBeenCalled();
      expect(accepted).not.toHaveBeenCalled();
    },
  );

  it("handles an unknown confirm result without automatically confirming or sending again", async () => {
    await ready();
    fill();
    request.mockRejectedValueOnce(Error("synthetic timeout"));
    confirm();
    await flush();
    expect(text(render())).toContain("可能已经完成设置");
    expect(text(render())).toContain("返回账号密码登录");
    expect(
      nodes(render()).some(
        (node) =>
          node.type === "input" && node.props.autoComplete === "one-time-code",
      ),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(authenticated).not.toHaveBeenCalled();
  });

  it("shows a safe server rejection and requires fresh manual code/password input before retry", async () => {
    await ready();
    fill();
    request.mockRejectedValueOnce(
      Object.assign(
        Error("初始化信息无效或已失效，请重新申请或使用已有登录方式"),
        { status: 401 },
      ),
    );
    confirm();
    await flush();
    expect(text(render())).toContain("初始化信息无效或已失效");
    confirm();
    expect(request).toHaveBeenCalledTimes(2);
    expect(input(render(), "短信验证码").props.value).toBe("");
    expect(input(render(), "设置新密码").props.value).toBe("");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed or unmasked responses without reflecting their secret or full phone", async () => {
    render();
    hooks.current!.flushEffects();
    change("本人已绑定手机号", "13800138000");
    request.mockResolvedValueOnce({
      ...challenge,
      maskedPhone: "13800138000",
      privateField: "never-display-me",
    });
    send();
    await flush();
    expect(text(render())).toContain("响应格式异常");
    expect(text(render())).not.toContain("13800138000");
    expect(JSON.stringify(render())).not.toContain(challenge.challengeSecret);
    expect(text(render())).not.toContain("never-display-me");
  });
});
