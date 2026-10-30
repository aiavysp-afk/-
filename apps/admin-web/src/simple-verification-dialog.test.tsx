import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRenderer } from "./test-hook-renderer";
import { SimpleVerificationDialog } from "./simple-verification-dialog";
const hooks = vi.hoisted(() => ({
  current: null as ReturnType<typeof createHookRenderer> | null,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (value: unknown) => hooks.current!.useState(value),
    useMemo: (...args: Parameters<typeof actual.useMemo>) =>
      hooks.current!.useMemo(...args),
    useRef: (...args: Parameters<typeof actual.useRef>) =>
      hooks.current!.useRef(...args),
    useEffect: (...args: Parameters<typeof actual.useEffect>) =>
      hooks.current!.useEffect(args[0], args[1] ?? []),
  };
});
type Node = { type: unknown; props: Record<string, any> };
const nodes = (value: any): Node[] =>
  Array.isArray(value)
    ? value.flatMap(nodes)
    : value && typeof value === "object" && value.props
      ? [value, ...nodes(value.props.children)]
      : [];
const content = (value: any): string =>
  value == null
    ? ""
    : typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.map(content).join("")
        : content(value.props?.children);
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), { status });
const close = vi.fn();
function render() {
  return hooks.current!.render(() =>
    SimpleVerificationDialog({ token: "isolated-fixture", onClose: close }),
  );
}
const flush = async () => {
  for (let i = 0; i < 70; i++) await Promise.resolve();
};
const buttons = () => nodes(render()).filter((node) => node.type === "button");
beforeEach(() => {
  hooks.current = createHookRenderer();
  close.mockClear();
});
afterEach(() => {
  hooks.current?.unmount();
  vi.unstubAllGlobals();
});
describe("same-page sensitive action verification", () => {
  it("requires an explicit verification and never retries the pending review action", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          enabled: true,
          staffEligible: true,
          enrollmentPending: false,
          lockedUntil: null,
        }),
      )
      .mockResolvedValueOnce(
        json({ verifiedUntil: new Date(Date.now() + 60000).toISOString() }),
      );
    vi.stubGlobal("fetch", fetcher);
    render();
    hooks.current!.flushEffects();
    await flush();
    expect(buttons()).toHaveLength(2);
    nodes(render())
      .find((node) => node.type === "input")!
      .props.onChange({ target: { value: "123456" } });
    const verify = buttons().find((node) => content(node) === "验证")!;
    verify.props.onClick();
    verify.props.onClick();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toContain("/auth/mfa/verify");
    expect(fetcher.mock.calls[1]![1].body).toBe('{"code":"123456"}');
    expect(content(render())).toContain("系统没有自动审核任何申请");
    expect(buttons()).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
  });
  it("does not enroll a device automatically and keeps first binding below three buttons", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          enabled: false,
          staffEligible: true,
          enrollmentPending: false,
          lockedUntil: null,
        }),
      )
      .mockResolvedValueOnce(
        json({
          secret: "SYNTHETIC-LOCAL-ONLY",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          issuer: "Fixture",
          accountName: "Fixture",
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    render();
    hooks.current!.flushEffects();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(buttons()).toHaveLength(2);
    buttons()
      .find((node) => content(node) === "开始绑定验证器")!
      .props.onClick();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(buttons()).toHaveLength(2);
    expect(content(render())).toContain("SYNTHETIC-LOCAL-ONLY");
    expect(
      buttons().find((node) => content(node) === "确认绑定")!.props.disabled,
    ).toBe(true);
  });
  it("leaves read failures with a single cancel action and no invented success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fixture failure")),
    );
    render();
    hooks.current!.flushEffects();
    await flush();
    expect(content(render())).toContain("验证配置暂时无法读取");
    expect(buttons()).toHaveLength(1);
    expect(content(render())).not.toContain("身份验证已完成");
  });

  it("resumes an existing pending binding without requesting or exposing its secret again", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          enabled: false,
          staffEligible: true,
          enrollmentPending: true,
          lockedUntil: null,
        }),
      )
      .mockResolvedValueOnce(
        json({ verifiedUntil: new Date(Date.now() + 60000).toISOString() }),
      );
    vi.stubGlobal("fetch", fetcher);
    render();
    hooks.current!.flushEffects();
    await flush();
    expect(content(render())).toContain("最初绑定的同一登录会话");
    expect(content(render())).toContain("自创建起10分钟到期");
    expect(content(render())).not.toContain("开始绑定验证器");
    expect(nodes(render()).filter((node) => node.type === "code")).toHaveLength(
      0,
    );
    expect(buttons()).toHaveLength(2);
    nodes(render())
      .find((node) => node.type === "input")!
      .props.onChange({ target: { value: "234567" } });
    buttons()
      .find((node) => content(node) === "确认绑定")!
      .props.onClick();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toContain("/auth/mfa/activate");
    expect(fetcher.mock.calls[1]![1].body).toBe('{"code":"234567"}');
    expect(fetcher.mock.calls[1]![1].headers.Authorization).toBe(
      "Bearer isolated-fixture",
    );
    expect(
      fetcher.mock.calls.some(([url]) => String(url).endsWith("/enrollment")),
    ).toBe(false);
    expect(content(render())).toContain("系统没有自动审核任何申请");
    expect(buttons()).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("shows the server lock deadline with only cancel and sends no verification while locked", async () => {
    const lockedUntil = new Date(Date.now() + 300000).toISOString();
    const fetcher = vi.fn().mockResolvedValueOnce(
      json({
        enabled: true,
        staffEligible: true,
        enrollmentPending: false,
        lockedUntil,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    render();
    hooks.current!.flushEffects();
    await flush();
    expect(content(render())).toContain("动态码验证已暂时锁定");
    expect(content(render())).toContain(
      new Date(lockedUntil).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      }),
    );
    expect(content(render())).toContain("重新打开验证窗口");
    expect(
      nodes(render()).filter((node) => node.type === "input"),
    ).toHaveLength(0);
    expect(buttons()).toHaveLength(1);
    expect(content(buttons()[0])).toBe("取消");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refreshes lock status after a failed code without repeating the code or review action", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          enabled: true,
          staffEligible: true,
          enrollmentPending: false,
          lockedUntil: null,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: "动态码无效、过期或已被使用" }),
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        json({
          enabled: true,
          staffEligible: true,
          enrollmentPending: false,
          lockedUntil: new Date(Date.now() + 300000).toISOString(),
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    render();
    hooks.current!.flushEffects();
    await flush();
    nodes(render())
      .find((node) => node.type === "input")!
      .props.onChange({ target: { value: "345678" } });
    buttons()
      .find((node) => content(node) === "验证")!
      .props.onClick();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]![1].method).toBe("POST");
    expect(fetcher.mock.calls[2]![1].method).toBe("GET");
    expect(
      fetcher.mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(1);
    expect(content(render())).toContain("动态码验证已暂时锁定");
    expect(content(render())).not.toContain("身份验证已完成");
    expect(buttons()).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("explains an expired or different-session pending binding without starting a replacement", async () => {
    const pending = {
      enabled: false,
      staffEligible: true,
      enrollmentPending: true,
      lockedUntil: null,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(pending))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: "绑定已过期或不属于当前登录会话" }),
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(json(pending));
    vi.stubGlobal("fetch", fetcher);
    render();
    hooks.current!.flushEffects();
    await flush();
    nodes(render())
      .find((node) => node.type === "input")!
      .props.onChange({ target: { value: "456789" } });
    buttons()
      .find((node) => content(node) === "确认绑定")!
      .props.onClick();
    await flush();
    expect(content(render())).toContain("待激活绑定已过期或属于原登录会话");
    expect(content(render())).not.toContain("身份验证已完成");
    expect(
      nodes(render()).find((node) => node.type === "input")!.props.value,
    ).toBe("");
    expect(buttons()).toHaveLength(2);
    expect(
      fetcher.mock.calls.some(([url]) => String(url).endsWith("/enrollment")),
    ).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });
});
