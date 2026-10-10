import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MfaGate } from "./mfa-gate";
import { MfaSession, type MfaSnapshot } from "./mfa-session";

const session = new MfaSession(vi.fn(), vi.fn());
const snapshot: MfaSnapshot = {
  status: {
    enabled: true,
    enrollmentPending: false,
    lockedUntil: null,
    verifiedUntil: null,
    required: true,
    staffEligible: true,
  },
  enrollment: null,
  busy: false,
  error: "",
};
describe("technician security gate", () => {
  it("presents current browser verification, no identity grant or workbench content", () => {
    const markup = renderToStaticMarkup(
      <MfaGate session={session} snapshot={snapshot} onLogout={vi.fn()} />,
    );
    expect(markup).toContain("验证当前会话");
    expect(markup).toContain('type="password"');
    expect(markup).toMatch(/autocomplete="one-time-code"/i);
    expect(markup).not.toContain("订单编号");
    expect(markup).not.toContain("开始绑定认证器");
  });
  it("offers explicit first-time binding without automatically exposing or generating secrets", () => {
    const value = {
      ...snapshot,
      status: { ...snapshot.status!, enabled: false },
    };
    const markup = renderToStaticMarkup(
      <MfaGate session={session} snapshot={value} onLogout={vi.fn()} />,
    );
    expect(markup).toContain("开始绑定认证器");
    expect(markup).not.toContain("确认绑定并验证");
    expect(markup).not.toContain("一次性绑定密钥");
  });
  it("does not expose activate controls for another session's pending enrollment", () => {
    const value = {
      ...snapshot,
      status: { ...snapshot.status!, enabled: false, enrollmentPending: true },
    };
    const markup = renderToStaticMarkup(
      <MfaGate session={session} snapshot={value} onLogout={vi.fn()} />,
    );
    expect(markup).toContain("不能接管其他会话");
    expect(markup).not.toContain("确认绑定并验证");
    expect(markup).not.toContain("开始绑定认证器");
  });
  it("displays an explicit in-memory secret locally with no external QR or secret URL", () => {
    const value = {
      ...snapshot,
      status: { ...snapshot.status!, enabled: false, enrollmentPending: true },
      enrollment: {
        secret: "SYNTHETIC_TEST_ONLY",
        expiresAt: "2099-01-01T00:00:00Z",
        issuer: "中原到家",
        accountName: "fixture-user",
      },
    };
    const markup = renderToStaticMarkup(
      <MfaGate session={session} snapshot={value} onLogout={vi.fn()} />,
    );
    expect(markup).toContain("SYNTHETIC_TEST_ONLY");
    expect(markup).toContain("确认绑定并验证");
    expect(markup).toContain("绑定期限（北京时间）：08:00:00");
    expect(markup).not.toMatch(
      /(?:src|href|action)="https?:\/\/|otpauth:|<img/,
    );
  });
  it("shows lock deadlines in Beijing time independently of the browser's timezone", () => {
    const value = {
      ...snapshot,
      status: { ...snapshot.status!, lockedUntil: "2099-01-01T00:00:00Z" },
    };
    const markup = renderToStaticMarkup(
      <MfaGate session={session} snapshot={value} onLogout={vi.fn()} />,
    );
    expect(markup).toContain("锁定至 08:00:00（北京时间）");
  });
});
