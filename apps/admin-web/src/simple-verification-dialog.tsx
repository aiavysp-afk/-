import { useEffect, useMemo, useRef, useState } from "react";
import { authenticatedFetch } from "./authenticated-fetch";
import { createLatestRequest } from "./synchronization";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
type Status = {
  enabled: boolean;
  staffEligible: boolean;
  enrollmentPending: boolean;
  lockedUntil: string | null;
};
type Enrollment = {
  secret: string;
  expiresAt: string;
  issuer: string;
  accountName: string;
};
function validStatus(data: Status) {
  return (
    typeof data.enabled === "boolean" &&
    typeof data.staffEligible === "boolean" &&
    typeof data.enrollmentPending === "boolean" &&
    (data.lockedUntil === null ||
      (typeof data.lockedUntil === "string" &&
        Number.isFinite(Date.parse(data.lockedUntil))))
  );
}
async function request<T>(
  token: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await authenticatedFetch(
    token,
    `${API_BASE_URL}/auth/mfa${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      credentials: "include",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const bindingExpired =
      response.status === 401 &&
      json?.message === "绑定已过期或不属于当前登录会话";
    const locked =
      response.status === 401 &&
      json?.message === "动态码验证已暂时锁定，请五分钟后重试";
    throw Error(
      bindingExpired
        ? "待激活绑定已过期或属于原登录会话；请等待本次绑定到期后，重新登录并开始绑定。"
        : locked
          ? "动态码验证已暂时锁定，请等待五分钟后重新打开验证窗口。"
          : response.status === 429
            ? "尝试次数较多，请稍后再验证。"
            : response.status === 403
              ? "当前不能完成绑定或验证，请重新登录后再试。"
              : "身份验证未完成，请检查动态码后重试。",
    );
  }
  if (!json?.data || typeof json.data !== "object")
    throw Error("验证服务返回异常，请稍后重试。");
  return json.data as T;
}

export function SimpleVerificationDialog({
  token,
  onClose,
}: {
  token: string;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const requests = useMemo(createLatestRequest, []);
  const operationBusy = useRef(false);
  const locked = Boolean(
    status?.lockedUntil && Date.parse(status.lockedUntil) > Date.now(),
  );
  useEffect(() => {
    const current = requests.begin();
    setLoading(true);
    setError("");
    void request<Status>(token, "")
      .then((data) => {
        if (!current()) return;
        if (!validStatus(data)) throw Error("验证配置读取失败。");
        setStatus(data);
      })
      .catch(() => {
        if (current()) setError("验证配置暂时无法读取，请关闭后重试。");
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => requests.invalidate();
  }, [token, requests]);
  async function refreshAfterFailure(isCurrent: () => boolean) {
    // A failed verification may have started the server's five-minute lock.
    // This is a read only; never repeat the code or the pending review action.
    try {
      const data = await request<Status>(token, "");
      if (!isCurrent() || !validStatus(data)) return;
      setStatus(data);
      if (data.enabled || !data.enrollmentPending) setEnrollment(null);
    } catch {
      // Keep the original failure if the status read is also unavailable.
    }
  }
  async function enroll() {
    if (
      operationBusy.current ||
      !status?.staffEligible ||
      status.enabled ||
      status.enrollmentPending ||
      locked
    )
      return;
    operationBusy.current = true;
    const current = requests.begin();
    setBusy(true);
    setError("");
    try {
      const data = await request<Enrollment>(token, "/enrollment", {});
      if (!current()) return;
      if (
        typeof data.secret !== "string" ||
        !data.secret ||
        !Number.isFinite(Date.parse(data.expiresAt))
      )
        throw Error("绑定资料读取失败，请重新登录后再试。");
      setEnrollment(data);
      setStatus((previous) =>
        previous ? { ...previous, enrollmentPending: true } : previous,
      );
    } catch (caught) {
      if (current()) {
        setError(caught instanceof Error ? caught.message : "绑定未完成。");
        await refreshAfterFailure(current);
      }
    } finally {
      operationBusy.current = false;
      if (current()) setBusy(false);
    }
  }
  async function verify() {
    if (
      operationBusy.current ||
      !/^\d{6}$/.test(code) ||
      !status?.staffEligible ||
      !(status.enabled || status.enrollmentPending || enrollment) ||
      locked
    )
      return;
    operationBusy.current = true;
    const current = requests.begin();
    setBusy(true);
    setError("");
    try {
      const data = await request<{ verifiedUntil: string }>(
        token,
        status.enabled ? "/verify" : "/activate",
        { code },
      );
      if (!current()) return;
      if (
        !Number.isFinite(Date.parse(data.verifiedUntil)) ||
        Date.parse(data.verifiedUntil) <= Date.now()
      )
        throw Error("验证结果已过期，请重试。");
      setCode("");
      setEnrollment(null);
      setSuccess(true);
    } catch (caught) {
      if (current()) {
        setCode("");
        setError(caught instanceof Error ? caught.message : "验证未完成。");
        await refreshAfterFailure(current);
      }
    } finally {
      operationBusy.current = false;
      if (current()) setBusy(false);
    }
  }
  return (
    <div className="simple-verification-backdrop">
      <section
        className="simple-verification-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="simple-verification-title"
      >
        <h2 id="simple-verification-title">确认本人操作</h2>
        {loading ? (
          <p role="status">正在读取验证设置…</p>
        ) : success ? (
          <p role="status">
            身份验证已完成。返回原页面后，请再次点击要执行的操作；系统没有自动审核任何申请。
          </p>
        ) : status && !status.staffEligible ? (
          <p>当前账号没有管理验证资格，请联系管理员。</p>
        ) : locked ? (
          <p role="status">
            动态码验证已暂时锁定，将于{" "}
            {new Date(status!.lockedUntil!).toLocaleString("zh-CN", {
              timeZone: "Asia/Shanghai",
              hour12: false,
            })}{" "}
            后恢复。届时请关闭并重新打开验证窗口；当前没有重复提交动态码。
          </p>
        ) : status?.enabled ? (
          <p>请填写手机验证器当前显示的6位动态码，用于确认本次审核操作。</p>
        ) : (
          <>
            {status?.enrollmentPending && !enrollment ? (
              <p>
                已有待激活的验证器绑定。若已在本人手机保存密钥，请在最初绑定的同一登录会话填写动态码确认绑定，密钥不会再次显示。
                若未保存密钥或已更换登录会话，请等待本次绑定自创建起10分钟到期后，重新登录并在五分钟内开始绑定。
              </p>
            ) : (
              <p>
                首次审核需要本人绑定手机验证器。请在新登录后五分钟内开始绑定。
              </p>
            )}
            {enrollment && (
              <>
                <p>
                  在手机验证器中手动添加账户“{enrollment.issuer} /{" "}
                  {enrollment.accountName}”，输入以下绑定密钥：
                </p>
                <code>{enrollment.secret}</code>
                <p>绑定密钥仅用于本人手机，不要发给他人或放入操作手册。</p>
              </>
            )}
          </>
        )}
        {error && (
          <p className="catalog-error" role="alert">
            {error}
          </p>
        )}
        {!loading &&
          !success &&
          !locked &&
          status?.staffEligible &&
          (status.enabled || status.enrollmentPending || enrollment) && (
            <label>
              验证器动态码
              <input
                type="password"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                disabled={busy}
                onChange={(event) =>
                  setCode(event.target.value.replace(/\D/g, ""))
                }
              />
            </label>
          )}
        <div className="catalog-actions">
          {!loading &&
          !success &&
          !locked &&
          status?.staffEligible &&
          (status.enabled || status.enrollmentPending || enrollment) ? (
            <button
              className="primary-action"
              disabled={busy || !/^\d{6}$/.test(code)}
              aria-busy={busy}
              onClick={() => void verify()}
            >
              {busy ? "正在验证…" : status.enabled ? "验证" : "确认绑定"}
            </button>
          ) : !loading && !success && !locked && status?.staffEligible ? (
            <button
              className="primary-action"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void enroll()}
            >
              {busy ? "正在准备…" : "开始绑定验证器"}
            </button>
          ) : null}
          <button className="ghost-action" disabled={busy} onClick={onClose}>
            {success ? "返回原页面" : "取消"}
          </button>
        </div>
      </section>
    </div>
  );
}
