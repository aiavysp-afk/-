import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCustomerPhoneDisclosure,
  customerDirectoryPaths,
  safeCustomerMaskedPhone,
  validCustomerPhoneReason,
  type CustomerPhoneDisclosure,
} from "./customer-center";
import {
  CustomerDirectory,
  requestCustomerDirectory,
} from "./customer-directory";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("customer directory privacy boundary", () => {
  it("does not query or expose controls to an anonymous visitor", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const html = renderToStaticMarkup(
      <CustomerDirectory token="" organizationId="org-a" />,
    );
    expect(html).toContain("未登录不会读取客户信息");
    expect(html).not.toContain("申请查看完整号码");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders a pending state, not a misleading empty directory before fetching", () => {
    const html = renderToStaticMarkup(
      <CustomerDirectory token="test" organizationId="org-a" />,
    );
    expect(html).toContain("正在读取本组织关联客户");
    expect(html).toContain("先在账户安全完成动态码验证");
    expect(html).toContain("尚未关联的新注册用户不会出现");
    expect(html).not.toContain("当前组织暂无关联客户");
  });

  it("escapes organization, customer and pagination identifiers independently", () => {
    const paths = customerDirectoryPaths("org/a");
    expect(paths.list("cursor&a")).toBe(
      "/admin/organizations/org%2Fa/customer-center/customers?limit=20&cursor=cursor%26a",
    );
    expect(paths.revealPhone("customer/a")).toBe(
      "/admin/organizations/org%2Fa/customer-center/customers/customer%2Fa/reveal-phone",
    );
  });

  it("will not accidentally render an unmasked number from the masked field", () => {
    expect(safeCustomerMaskedPhone("138****1234")).toBe("138****1234");
    expect(safeCustomerMaskedPhone("13800001234")).toBe("未展示号码");
    expect(safeCustomerMaskedPhone(null)).toBe("未展示号码");
    expect(validCustomerPhoneReason("  核实预约资料  ")).toBe(true);
    expect(validCustomerPhoneReason("短")).toBe(false);
    expect(validCustomerPhoneReason("用".repeat(201))).toBe(false);
  });

  it("caps displayed numbers at 60 seconds and hides automatically", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
    const changes = vi.fn();
    const guard = createCustomerPhoneDisclosure(changes);
    const ticket = guard.begin("customer-a");
    expect(
      guard.show(ticket, {
        userId: "customer-a",
        phone: "13800001234",
        expiresAt: "2026-10-16T00:30:00Z",
      }),
    ).toBe(true);
    expect(changes).toHaveBeenLastCalledWith({
      userId: "customer-a",
      phone: "13800001234",
      expiresAt: "2026-10-16T00:01:00.000Z",
    });
    vi.advanceTimersByTime(59_999);
    expect(ticket.isCurrent()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(changes).toHaveBeenLastCalledWith(null);
    expect(ticket.isCurrent()).toBe(false);
  });

  it("honors a shorter server expiry and rejects expired or mismatched disclosures", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
    const changes = vi.fn();
    const guard = createCustomerPhoneDisclosure(changes);
    const ticket = guard.begin("customer-a");
    const value: CustomerPhoneDisclosure = {
      userId: "customer-a",
      phone: "13800001234",
      expiresAt: "2026-10-16T00:00:10Z",
    };
    expect(guard.show(ticket, { ...value, userId: "customer-b" })).toBe(false);
    expect(guard.show(ticket, { ...value, phone: "invalid" })).toBe(false);
    expect(
      guard.show(ticket, { ...value, expiresAt: "2026-10-15T23:59:00Z" }),
    ).toBe(false);
    expect(guard.show(ticket, { ...value, expiresAt: "invalid" })).toBe(false);
    expect(guard.show(ticket, value)).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(changes).toHaveBeenLastCalledWith(null);
  });

  it("aborts and rejects late responses after blur, hiding, refresh or scope teardown", () => {
    const changes = vi.fn();
    const guard = createCustomerPhoneDisclosure(changes);
    const ticket = guard.begin("customer-a");
    guard.clear();
    expect(ticket.signal.aborted).toBe(true);
    expect(
      guard.show(ticket, {
        userId: "customer-a",
        phone: "13800001234",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toBe(false);
    const second = guard.begin("customer-a");
    expect(second.isCurrent()).toBe(true);
    guard.dispose();
    expect(second.signal.aborted).toBe(true);
    expect(second.isCurrent()).toBe(false);
    expect(changes).toHaveBeenLastCalledWith(null);
  });

  it("supersedes an earlier number request without disclosing the earlier response", () => {
    const changes = vi.fn();
    const guard = createCustomerPhoneDisclosure(changes);
    const previous = guard.begin("customer-a");
    const next = guard.begin("customer-b");
    expect(previous.isCurrent()).toBe(false);
    expect(next.isCurrent()).toBe(true);
    expect(
      guard.show(previous, {
        userId: "customer-a",
        phone: "13800001234",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toBe(false);
    guard.dispose();
  });

  it("sends list GETs without a JSON body and disables caching", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { items: [], nextCursor: null } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await requestCustomerDirectory("/directory", "session", signal);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/directory"), {
      method: "GET",
      cache: "no-store",
      signal,
      headers: { Authorization: "Bearer session" },
    });
  });

  it("posts a reason only on explicit reveal and never reflects server error PII", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "13800001234 sensitive" }), {
        status: 403,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      requestCustomerDirectory(
        "/reveal-phone",
        "session",
        new AbortController().signal,
        "核实预约信息",
      ),
    ).rejects.toThrow("请先在账户安全完成动态码验证");
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        body: JSON.stringify({ reason: "核实预约信息" }),
      }),
    );
  });

  it("rejects accidental full-phone list payloads before putting them in UI state", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            items: [
              {
                userId: "customer-a",
                displayName: "客户",
                phoneVerified: true,
                maskedPhone: "13800001234",
                createdAt: "2026-10-16T00:00:00Z",
              },
            ],
            nextCursor: null,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      requestCustomerDirectory(
        "/directory",
        "session",
        new AbortController().signal,
      ),
    ).rejects.toThrow("客户资料暂时无法读取");
  });

  it("validates a reveal response without retaining unknown provider or identity fields", async () => {
    const result = {
      userId: "customer-a",
      phone: "13800001234",
      expiresAt: "2026-10-16T00:01:00Z",
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: result }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { ...result, openId: "private-openid" } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      requestCustomerDirectory(
        "/reveal-phone",
        "session",
        new AbortController().signal,
        "核实预约信息",
      ),
    ).resolves.toEqual(result);
    await expect(
      requestCustomerDirectory(
        "/reveal-phone",
        "session",
        new AbortController().signal,
        "核实预约信息",
      ),
    ).rejects.toThrow("客户资料暂时无法读取");
    expect(validCustomerPhoneReason("核实\u0000预约信息")).toBe(false);
  });
});
