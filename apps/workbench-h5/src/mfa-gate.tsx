import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { MfaSession, MfaSnapshot } from "./mfa-session";

function formatMfaTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function MfaGate({
  session,
  snapshot,
  onLogout,
}: {
  session: MfaSession;
  snapshot: MfaSnapshot;
  onLogout: () => void;
}) {
  const [code, setCode] = useState("");
  const { status, enrollment, busy, error } = snapshot;
  const locked = Date.parse(status?.lockedUntil ?? "") > Date.now();
  const enrollmentValid =
    enrollment && Date.parse(enrollment.expiresAt) > Date.now();
  return (
    <section className="workbench-gate mfa-gate">
      <ShieldAlert size={24} />
      <h2>当前设备安全验证</h2>
      <p>
        手机确认登录后，还需验证本次浏览器会话。验证有效期约五分钟，到期后需再次输入动态码。
      </p>
      {busy && <p role="status">正在读取安全验证状态…</p>}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {status && !status.staffEligible && (
        <p>当前账号不具备有效工作人员身份，请联系管理人员核对。</p>
      )}
      {status?.staffEligible &&
        !status.enabled &&
        !status.enrollmentPending && (
          <>
            <p>
              首次使用请在本人设备上的认证器中绑定。需在微信登录确认后五分钟内发起；过期请退出后重新登录。
            </p>
            <button disabled={busy} onClick={() => void session.enroll()}>
              开始绑定认证器
            </button>
          </>
        )}
      {enrollmentValid && (
        <div className="mfa-enrollment">
          <strong>请在本人认证器中手动添加</strong>
          <span>名称：{enrollment.issuer}</span>
          <span>账号：{enrollment.accountName}</span>
          <label>一次性绑定密钥（勿分享或截图）</label>
          <code>{enrollment.secret}</code>
          <small>
            时间型 TOTP · SHA-1 · 六位数字 · 30
            秒。密钥仅在本页内存中显示，刷新或退出后无法找回。
          </small>
          <small>
            绑定期限（北京时间）：{formatMfaTime(enrollment.expiresAt)}
          </small>
        </div>
      )}
      {status?.enrollmentPending && !status.enabled && !enrollmentValid && (
        <p>
          已有待完成的绑定，但本页没有有效密钥。请在原页面完成，或等待原绑定十分钟期限结束后刷新状态；本页不能接管其他会话的绑定。
        </p>
      )}
      {status?.staffEligible && (status.enabled || enrollmentValid) && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const submitted = code;
            setCode("");
            void session.verify(submitted);
          }}
        >
          <label htmlFor="mfa-code">认证器六位动态码</label>
          <input
            id="mfa-code"
            type="password"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            disabled={busy || locked}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
          />
          <button
            disabled={busy || locked || !/^\d{6}$/.test(code)}
            type="submit"
          >
            {status.enabled ? "验证当前会话" : "确认绑定并验证"}
          </button>
        </form>
      )}
      {locked && (
        <p>
          多次验证失败，暂时锁定至 {formatMfaTime(status!.lockedUntil!)}
          （北京时间）。请稍后刷新状态，不要连续尝试。
        </p>
      )}
      <button
        className="secondary"
        disabled={busy}
        onClick={() => void session.refresh()}
      >
        刷新安全状态
      </button>
      <button className="secondary" onClick={onLogout}>
        退出登录
      </button>
      <small>
        无法使用原认证器时，请通过小程序工作人员入口发起恢复，并等待管理员审核。
      </small>
    </section>
  );
}
