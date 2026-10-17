import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserLogin, loginRequest } from "./browser-login";
import { SecurityWorkspace } from "./security";
import { StaffSecurity } from "./staff-security";

afterEach(() => vi.unstubAllGlobals());

describe("dual admin login rendering", () => {
  it("shows password plus SMS by default and retains WeChat as an alternate method", () => {
    const html = renderToStaticMarkup(<BrowserLogin onSession={() => {}} />);
    expect(html).toContain("微信登录");
    expect(html).toContain("默认方式");
    expect(html).toContain("备用方式");
    expect(html).toContain("账号密码登录");
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-label="账号密码登录"');
    expect(html).not.toContain("我的 → 后台登录确认");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("已登录成功");
  });

  it("makes both methods available in account security for an anonymous browser", () => {
    const html = renderToStaticMarkup(
      <SecurityWorkspace
        token=""
        onLogout={async () => {}}
        onSession={() => {}}
      />,
    );
    expect(html).toContain("选择登录方式");
    expect(html).toContain("账号密码登录");
    expect(html).not.toContain("暂无已登记的信任设备");
    expect(html).not.toContain("验证器丢失恢复复核");
  });

  it("does not claim there are no devices or passwords before reading real security data", () => {
    const html = renderToStaticMarkup(
      <StaffSecurity token="isolated-test-token" verifiedUntil={null} />,
    );
    expect(html).toContain("密码配置尚未读取成功");
    expect(html).toContain("信任设备配置尚未读取成功");
    expect(html).not.toContain("暂无已登记的信任设备");
    expect(html).not.toContain('type="password"');
  });
});

describe("admin login transport", () => {
  it("uses cookie-aware GET without a JSON content-type or body", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _options?: RequestInit) => ({
        ok: true,
        json: async () => ({ data: { enabled: false } }),
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await loginRequest("/auth/trusted-devices/config")).toEqual({
      enabled: false,
    });
    const options = fetcher.mock.calls[0]![1] as RequestInit;
    expect(options.method).toBe("GET");
    expect(options.credentials).toBe("include");
    expect(options.headers).not.toHaveProperty("Content-Type");
    expect(options).not.toHaveProperty("body");
  });

  it("sends JSON only for a mutation and uses the existing bearer session", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _options?: RequestInit) => ({
        ok: true,
        json: async () => ({ data: { trusted: false } }),
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    await loginRequest(
      "/auth/trusted-devices/accept",
      {},
      "isolated-test-token",
    );
    const options = fetcher.mock.calls[0]![1] as RequestInit;
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({
      Authorization: "Bearer isolated-test-token",
      "Content-Type": "application/json",
    });
    expect(options.body).toBe("{}");
    expect(options.credentials).toBe("include");
  });

  it("reports an unavailable endpoint without fabricating verification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ message: "短信通道尚未开放" }),
      })),
    );
    await expect(
      loginRequest("/auth/staff-password/login", {
        account: "13800000000",
        password: "isolated-test-value",
      }),
    ).rejects.toThrow("短信通道尚未开放");
  });
});
