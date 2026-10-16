import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthSession } from "@zydj/contracts";
import { BrowserLogin } from "./browser-login";
import { StaffSecurity } from "./staff-security";
import { createLoginGeneration, hasFreshTotp } from "./login-state";
import { authenticatedFetch } from "./authenticated-fetch";
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
type MfaStatus = {
  enabled: boolean;
  enrollmentPending: boolean;
  lockedUntil: string | null;
  verifiedUntil: string | null;
  loginVerifiedUntil?: string | null;
  loginMethod?: string | null;
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
type SecurityWorkspaceProps = {
  token: string;
  onLogout: () => Promise<void>;
  onSession: (session: AuthSession) => void;
};

export function SecurityWorkspace(props: SecurityWorkspaceProps) {
  return <SecurityWorkspaceScope key={props.token} {...props} />;
}

function SecurityWorkspaceScope({
  token,
  onLogout,
  onSession,
}: SecurityWorkspaceProps) {
  const currentToken = useRef(token);
  currentToken.current = token;
  const [status, setStatus] = useState<MfaStatus | null>(null),
    [enrollment, setEnrollment] = useState<Enrollment | null>(null),
    [reviewOrganizations, setReviewOrganizations] = useState<string[]>([]),
    [recoveries, setRecoveries] = useState<RecoveryRequest[]>([]);
  const [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const requests = useMemo(createLoginGeneration, []);
  async function requestAt<T>(path: string, body?: unknown) {
    const response = await authenticatedFetch(token, `${API_BASE_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      credentials: "include",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json().catch(() => ({}))) ?? {};
    if (!response.ok)
      throw Object.assign(
        Error(
          typeof json.message === "string" ? json.message : "安全验证请求失败",
        ),
        { status: response.status },
      );
    return json.data as T;
  }
  async function request<T>(path: string, body?: unknown) {
    return requestAt<T>(`/auth/mfa${path}`, body);
  }
  function beginRequest() {
    const identity = token;
    const isLatest = requests.begin();
    setBusy(true);
    setError("");
    setRecoveries([]);
    setRecoveryError("");
    setRecoveryLoading(hasFreshTotp(status) && reviewOrganizations.length > 0);
    return () => isLatest() && currentToken.current === identity;
  }
  function clearSecurityState() {
    setStatus(null);
    setEnrollment(null);
    setCode("");
    setReviewOrganizations([]);
    setRecoveries([]);
    setRecoveryLoading(false);
    setRecoveryError("");
  }
  function reportError(caught: unknown, fallback: string, clear = false) {
    if (clear) clearSecurityState();
    setError(caught instanceof Error ? caught.message : fallback);
  }
  async function loadSecurity(isCurrent: () => boolean) {
    try {
      const [data, me] = await Promise.all([
        request<MfaStatus>(""),
        requestAt<{ memberships: Membership[] }>("/auth/me"),
      ]);
      const organizations = me.memberships
        .filter((membership) => membership.role === "ADMIN")
        .map((membership) => membership.organizationId);
      if (!isCurrent()) return;
      // Optional organization recovery queues must not block self MFA setup,
      // verification or credential management once the self reads succeeded.
      setStatus(data);
      setReviewOrganizations(organizations);
      setRecoveries([]);
      setBusy(false);
      if (hasFreshTotp(data) && organizations.length) {
        setRecoveryLoading(true);
        try {
          const queue = (
            await Promise.all(
              organizations.map((organizationId) =>
                requestAt<RecoveryRequest[]>(
                  `/admin/organizations/${encodeURIComponent(organizationId)}/mfa-recovery-requests`,
                ),
              ),
            )
          ).flat();
          if (isCurrent()) setRecoveries(queue);
        } catch (caught) {
          if (!isCurrent()) return;
          // A queue 401 can mean fresh MFA is required, not that the browser
          // session expired. authenticatedFetch confirms identity separately.
          setRecoveries([]);
          setRecoveryError(
            caught instanceof Error
              ? `恢复队列读取失败：${caught.message}`
              : "恢复队列读取失败，请重试",
          );
        } finally {
          if (isCurrent()) setRecoveryLoading(false);
        }
      }
    } catch (caught) {
      if (isCurrent()) reportError(caught, "读取失败", true);
    }
  }
  async function refresh() {
    const isCurrent = beginRequest();
    try {
      await loadSecurity(isCurrent);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  useEffect(() => {
    clearSecurityState();
    setError("");
    setBusy(false);
    if (token) void refresh();
    return () => requests.invalidate();
  }, [token, requests]);
  async function enroll() {
    if (busy) return;
    const isCurrent = beginRequest();
    try {
      const data = await request<Enrollment>("/enrollment", {});
      if (!isCurrent()) return;
      setEnrollment(data);
      await loadSecurity(isCurrent);
    } catch (caught) {
      if (isCurrent()) reportError(caught, "绑定失败");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function verify() {
    if (busy || !/^\d{6}$/.test(code)) return;
    const isCurrent = beginRequest();
    try {
      await request(status?.enabled ? "/verify" : "/activate", { code });
      if (!isCurrent()) return;
      setCode("");
      setEnrollment(null);
      await loadSecurity(isCurrent);
    } catch (caught) {
      if (isCurrent()) {
        setCode("");
        reportError(caught, "验证失败");
      }
    } finally {
      if (isCurrent()) setBusy(false);
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
    const isCurrent = beginRequest();
    try {
      await requestAt(
        `/admin/organizations/${encodeURIComponent(request.organizationId)}/mfa-recovery-requests/${encodeURIComponent(request.id)}/${decision}`,
        decision === "approve" ? {} : { reasonCode: "IDENTITY_NOT_CONFIRMED" },
      );
      if (isCurrent()) await loadSecurity(isCurrent);
    } catch (caught) {
      if (isCurrent()) reportError(caught, "恢复复核失败");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function logoutCurrent() {
    if (busy) return;
    const isCurrent = beginRequest();
    try {
      await onLogout();
    } catch (caught) {
      if (isCurrent()) reportError(caught, "注销失败");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  return (
    <section className="workspace">
      <p className="eyebrow">ACCOUNT SECURITY</p>
      <h2>后台安全验证</h2>
      <p>
        微信确认 + 动态码为主方式，也可使用本人账号密码 +
        手机短信。常用设备信任只简化登录，敏感操作仍须独立验证器动态码。
      </p>
      {!token ? (
        <BrowserLogin onSession={onSession} />
      ) : (
        <>
          <div className="toolbar">
            <button disabled={busy} onClick={() => void refresh()}>
              刷新安全状态
            </button>
            <button disabled={busy} onClick={() => void logoutCurrent()}>
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
                敏感操作动态码有效至：
                {status.verifiedUntil
                  ? new Date(status.verifiedUntil).toLocaleString("zh-CN", {
                      timeZone: "Asia/Shanghai",
                    })
                  : "尚未验证"}
                。到期后审核、发布和账号安全等敏感操作会要求重新验证。
              </p>
              {status.loginVerifiedUntil && (
                <p>
                  登录二次验证：
                  {status.loginMethod === "PASSWORD_SMS" ||
                  status.loginMethod === "SMS"
                    ? "手机短信"
                    : status.loginMethod === "TRUSTED_DEVICE"
                      ? "已登记常用设备"
                      : "已完成"}
                  · 有效至{" "}
                  {new Date(status.loginVerifiedUntil).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                  })}
                  。 这不是新的动态码验证，不能代替敏感操作授权。
                </p>
              )}
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
                  {!status.enabled &&
                    status.enrollmentPending &&
                    !enrollment && (
                      <div className="environment-banner">
                        <p>
                          已有待激活绑定。密钥仅在创建时显示，本页刷新后不会再次显示密钥。
                        </p>
                        <p>
                          若已录入验证器，且仍在最初发起绑定的同一登录会话，请输入当前六位动态码确认绑定。
                        </p>
                        <p>
                          若未保存密钥，或已经退出、更换登录会话，请等待该次未激活绑定自创建起
                          10 分钟的有效期结束，
                          再刷新安全状态。确认待激活状态结束后，注销并重新微信登录，在新登录会话创建后
                          5 分钟内重新开始绑定。
                          重新登录不能激活旧会话的待激活绑定，请勿反复提交动态码。
                        </p>
                        <p>
                          请勿向任何人发送密钥或动态码；此处不会重发、重置或替换已绑定验证器。
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
                ) : !hasFreshTotp(status) ? (
                  <p>请先用自己的验证器完成当前会话MFA，再读取待复核申请。</p>
                ) : recoveryLoading ? (
                  <p>正在读取恢复队列…</p>
                ) : recoveryError ? (
                  <p role="alert">
                    {recoveryError}
                    ；不会据此显示为无待审核申请，请点击刷新安全状态重试。
                  </p>
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
              {status.staffEligible && (
                <StaffSecurity
                  key={token}
                  token={token}
                  verifiedUntil={status.verifiedUntil}
                  onSecurityChange={refresh}
                />
              )}
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
