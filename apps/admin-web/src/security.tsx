import { useEffect, useRef, useState } from "react";
import type { AuthSession } from "@zydj/contracts";
import { BrowserLogin } from "./browser-login";
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
type MfaStatus = {
  enabled: boolean;
  enrollmentPending: boolean;
  lockedUntil: string | null;
  verifiedUntil: string | null;
  required: boolean;
  staffEligible: boolean;
};
type Enrollment = {
  secret: string;
  expiresAt: string;
  issuer: string;
  accountName: string;
};
export function SecurityWorkspace({
  token,
  onLogout,
  onSession,
}: {
  token: string;
  onLogout: () => Promise<void>;
  onSession: (session: AuthSession) => void;
}) {
  const currentToken = useRef(token);
  currentToken.current = token;
  const [status, setStatus] = useState<MfaStatus | null>(null),
    [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function request<T>(path: string, body?: unknown) {
    const response = await fetch(`${API_BASE_URL}/auth/mfa${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json();
    if (!response.ok)
      throw Error(
        typeof json.message === "string" ? json.message : "安全验证请求失败",
      );
    return json.data as T;
  }
  async function refresh() {
    const identity = token;
    setError("");
    try {
      const data = await request<MfaStatus>("");
      if (currentToken.current === identity) setStatus(data);
    } catch (e) {
      if (currentToken.current === identity)
        setError(e instanceof Error ? e.message : "读取失败");
    }
  }
  useEffect(() => {
    setStatus(null);
    setEnrollment(null);
    setCode("");
    setError("");
    setBusy(false);
    if (token) void refresh();
  }, [token]);
  async function enroll() {
    const identity = token;
    setBusy(true);
    setError("");
    try {
      const data = await request<Enrollment>("/enrollment", {});
      if (currentToken.current === identity) {
        setEnrollment(data);
        await refresh();
      }
    } catch (e) {
      if (currentToken.current === identity)
        setError(e instanceof Error ? e.message : "绑定失败");
    } finally {
      if (currentToken.current === identity) setBusy(false);
    }
  }
  async function verify() {
    const identity = token;
    setBusy(true);
    setError("");
    try {
      await request(status?.enabled ? "/verify" : "/activate", { code });
      if (currentToken.current === identity) {
        setCode("");
        setEnrollment(null);
        await refresh();
      }
    } catch (e) {
      if (currentToken.current === identity) {
        setCode("");
        setError(e instanceof Error ? e.message : "验证失败");
      }
    } finally {
      if (currentToken.current === identity) setBusy(false);
    }
  }
  return (
    <section className="workspace">
      <p className="eyebrow">ACCOUNT SECURITY</p>
      <h2>后台安全验证</h2>
      <p>
        第一层是微信身份会话，第二层是独立验证器动态码。后台人员生产操作必须通过两层验证。
      </p>
      {!token ? (
        <BrowserLogin onSession={onSession} />
      ) : (
        <>
          <div className="toolbar">
            <button disabled={busy} onClick={() => void refresh()}>
              刷新安全状态
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void onLogout().catch((e) =>
                  setError(e instanceof Error ? e.message : "注销失败"),
                )
              }
            >
              注销当前会话
            </button>
          </div>
          {status && (
            <>
              <p>
                验证器：
                {status.enabled
                  ? "已绑定"
                  : status.enrollmentPending
                    ? "待激活"
                    : "未绑定"}{" "}
                · 后台门禁：
                {status.required ? "强制MFA" : "私有开发模式（生产仍强制）"}
              </p>
              <p>
                当前会话验证有效至：
                {status.verifiedUntil
                  ? new Date(status.verifiedUntil).toLocaleString("zh-CN", {
                      timeZone: "Asia/Shanghai",
                    })
                  : "尚未验证"}
                。过期后后台会拒绝操作，请重新验证。
              </p>
              {!status.staffEligible ? (
                <p>当前身份没有已授权后台/技师成员资格，不能绑定验证器。</p>
              ) : (
                <>
                  {!status.enabled && !status.enrollmentPending && (
                    <button disabled={busy} onClick={() => void enroll()}>
                      开始绑定验证器（需五分钟内的新微信登录）
                    </button>
                  )}
                  {enrollment && (
                    <div className="environment-banner">
                      <p>
                        仅本次显示：请手动录入独立验证器，不要截图、分享或交给在线二维码网站。
                      </p>
                      <p>
                        发行方：{enrollment.issuer} · 账号：
                        {enrollment.accountName}
                      </p>
                      <code>{enrollment.secret}</code>
                      <p>
                        SHA1 / 六位数字 / 30秒。绑定到期：
                        {new Date(enrollment.expiresAt).toLocaleString(
                          "zh-CN",
                          { timeZone: "Asia/Shanghai" },
                        )}
                      </p>
                    </div>
                  )}
                  {(status.enabled || status.enrollmentPending) && (
                    <div className="toolbar">
                      <label>
                        六位动态码{" "}
                        <input
                          type="password"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={6}
                          value={code}
                          onChange={(e) =>
                            setCode(e.target.value.replace(/\D/g, ""))
                          }
                        />
                      </label>
                      <button
                        disabled={busy || !/^\d{6}$/.test(code)}
                        onClick={() => void verify()}
                      >
                        {status.enabled ? "验证当前会话" : "确认绑定"}
                      </button>
                    </div>
                  )}
                </>
              )}
              {status.lockedUntil && (
                <p>
                  失败锁定至：
                  {new Date(status.lockedUntil).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                  })}
                </p>
              )}
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <p>
        同一个动态码只可使用一次；连续五次失败会暂时锁定。已绑定验证器不能在此直接替换或关闭，丢失设备的受审恢复流程尚未实现，不能绕过门禁。
      </p>
    </section>
  );
}
