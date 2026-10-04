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
type Membership = { organizationId: string; role: string };
type RecoveryRequest = {
  id: string;
  organizationId: string;
  targetUserId: string;
  targetDisplayName: string | null;
  status: string;
  reasonCode: string | null;
  createdAt: string;
  expiresAt: string;
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
    [enrollment, setEnrollment] = useState<Enrollment | null>(null),
    [reviewOrganizations, setReviewOrganizations] = useState<string[]>([]),
    [recoveries, setRecoveries] = useState<RecoveryRequest[]>([]);
  const [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function requestAt<T>(path: string, body?: unknown) {
    const response = await fetch(`${API_BASE_URL}${path}`, {
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
  async function request<T>(path: string, body?: unknown) {
    return requestAt<T>(`/auth/mfa${path}`, body);
  }
  async function refresh() {
    const identity = token;
    setError("");
    try {
      const [data, me] = await Promise.all([
        request<MfaStatus>(""),
        requestAt<{ memberships: Membership[] }>("/auth/me"),
      ]);
      const organizations = me.memberships
        .filter((membership) => membership.role === "ADMIN")
        .map((membership) => membership.organizationId);
      let queue: RecoveryRequest[] = [];
      if (
        data.verifiedUntil &&
        new Date(data.verifiedUntil).getTime() > Date.now() &&
        organizations.length
      ) {
        queue = (
          await Promise.all(
            organizations.map((organizationId) =>
              requestAt<RecoveryRequest[]>(
                `/admin/organizations/${encodeURIComponent(organizationId)}/mfa-recovery-requests`,
              ),
            ),
          )
        ).flat();
      }
      if (currentToken.current === identity) {
        setStatus(data);
        setReviewOrganizations(organizations);
        setRecoveries(queue);
      }
    } catch (e) {
      if (currentToken.current === identity)
        setError(e instanceof Error ? e.message : "读取失败");
    }
  }
  useEffect(() => {
    setStatus(null);
    setEnrollment(null);
    setReviewOrganizations([]);
    setRecoveries([]);
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
  async function reviewRecovery(
    request: RecoveryRequest,
    decision: "approve" | "reject",
  ) {
    if (busy || request.status !== "PENDING") return;
    const label = request.targetDisplayName || request.targetUserId;
    if (
      !window.confirm(
        decision === "approve"
          ? `确认已线下核验${label}本人身份？批准后其旧验证器及全部会话立即失效。`
          : `确认拒绝${label}的验证器恢复申请？`,
      )
    )
      return;
    const identity = token;
    setBusy(true);
    setError("");
    try {
      await requestAt(
        `/admin/organizations/${encodeURIComponent(request.organizationId)}/mfa-recovery-requests/${encodeURIComponent(request.id)}/${decision}`,
        decision === "approve" ? {} : { reasonCode: "IDENTITY_NOT_CONFIRMED" },
      );
      if (currentToken.current === identity) await refresh();
    } catch (e) {
      if (currentToken.current === identity)
        setError(e instanceof Error ? e.message : "恢复复核失败");
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
              <div className="recovery-review">
                <h3>验证器丢失恢复复核</h3>
                {!reviewOrganizations.length ? (
                  <p>只有同组织管理员可以复核恢复申请。</p>
                ) : !status.verifiedUntil ||
                  new Date(status.verifiedUntil).getTime() <= Date.now() ? (
                  <p>请先用自己的验证器完成当前会话MFA，再读取待复核申请。</p>
                ) : recoveries.filter((item) => item.status === "PENDING")
                    .length ? (
                  recoveries
                    .filter((item) => item.status === "PENDING")
                    .map((item) => (
                      <article className="recovery-card" key={item.id}>
                        <strong>
                          {item.targetDisplayName || item.targetUserId}
                        </strong>
                        <p>
                          组织：{item.organizationId} · 到期：
                          {new Date(item.expiresAt).toLocaleString("zh-CN", {
                            timeZone: "Asia/Shanghai",
                          })}
                        </p>
                        <div className="toolbar">
                          <button
                            disabled={busy}
                            onClick={() => void reviewRecovery(item, "approve")}
                          >
                            身份核验通过并撤销旧因子
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => void reviewRecovery(item, "reject")}
                          >
                            身份未核验，拒绝
                          </button>
                        </div>
                      </article>
                    ))
                ) : (
                  <p>当前没有待复核的恢复申请。</p>
                )}
              </div>
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <p>
        同一个动态码只可使用一次；连续五次失败会暂时锁定。已绑定验证器不能直接替换或关闭；丢失设备必须由本人在小程序重新微信登录申请，并由另一名已完成MFA的同组织管理员复核。
      </p>
    </section>
  );
}
