import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthSession } from "@zydj/contracts";
import { createLoginGeneration, deliverBrowserSession } from "./login-state";
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";

type Pair = {
  pairCode: string;
  browserSecret: string;
  confirmationCode: string;
  expiresAt: string;
};
type PasswordChallenge = {
  challengeId: string;
  challengeSecret: string;
  maskedPhone: string;
  expiresAt: string;
  retryAfterSeconds: number;
};
type LoginMethod = "wechat" | "password";

export async function loginRequest<T>(
  path: string,
  body?: unknown,
  token?: string,
) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Error(
      typeof json.message === "string" ? json.message : "登录请求失败",
    );
  return json.data as T;
}
const proof = (pair: Pair) => ({
  pairCode: pair.pairCode,
  browserSecret: pair.browserSecret,
});
const revoke = async (session: AuthSession) => {
  await loginRequest("/auth/logout", {}, session.accessToken).catch(() => {});
};

export function BrowserLogin({
  onSession,
}: {
  onSession: (session: AuthSession) => void;
}) {
  const [method, setMethod] = useState<LoginMethod>("wechat");
  const [wechatConfig, setWechatConfig] = useState<{
    enabled: boolean;
    provider: string;
  } | null>(null);
  const [passwordConfig, setPasswordConfig] = useState<{
    enabled: boolean;
    smsEnabled: boolean;
  } | null>(null);
  const [configError, setConfigError] = useState("");
  const [pair, setPair] = useState<Pair | null>(null);
  const [challenge, setChallenge] = useState<PasswordChallenge | null>(null);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requests = useMemo(createLoginGeneration, []);
  const currentPair = useRef<Pair | null>(null);
  currentPair.current = pair;

  useEffect(() => {
    let active = true;
    void loginRequest<{ enabled: boolean; provider: string }>(
      "/auth/browser-login/config",
    )
      .then((data) => {
        if (active) setWechatConfig(data);
      })
      .catch(() => {
        if (active) setConfigError("微信登录配置暂时不可读，请稍后刷新。");
      });
    void loginRequest<{ enabled: boolean; smsEnabled: boolean }>(
      "/auth/staff-password/config",
    )
      .then((data) => {
        if (active) setPasswordConfig(data);
      })
      .catch(() => {
        if (active)
          setConfigError((message) =>
            `${message} 账号密码登录配置暂时不可读。`.trim(),
          );
      });
    return () => {
      active = false;
      requests.invalidate();
      const pending = currentPair.current;
      if (pending)
        void loginRequest("/auth/browser-login/cancel", proof(pending)).catch(
          () => {},
        );
    };
  }, [requests]);

  function resetAttempt(nextMethod: LoginMethod) {
    requests.invalidate();
    const pending = currentPair.current;
    currentPair.current = null;
    setPair(null);
    setChallenge(null);
    setPassword("");
    setSmsCode("");
    setBusy(false);
    setError("");
    setMethod(nextMethod);
    if (pending)
      void loginRequest("/auth/browser-login/cancel", proof(pending)).catch(
        () => {},
      );
  }
  async function deliver(session: AuthSession, isCurrent: () => boolean) {
    return deliverBrowserSession(
      session,
      isCurrent,
      async (identity) => {
        const trust = await loginRequest<{ enabled: boolean }>(
          "/auth/trusted-devices/config",
        );
        return trust.enabled
          ? loginRequest(
              "/auth/trusted-devices/accept",
              {},
              identity.accessToken,
            )
          : { trusted: false };
      },
      revoke,
      (identity) => {
        currentPair.current = null;
        setPair(null);
        setChallenge(null);
        setPassword("");
        setSmsCode("");
        onSession(identity);
      },
    );
  }
  async function startWechat() {
    if (busy || pair || !wechatConfig?.enabled) return;
    const isCurrent = requests.begin();
    setBusy(true);
    setError("");
    try {
      const created = await loginRequest<Pair>(
        "/auth/browser-login/create",
        {},
      );
      if (isCurrent()) {
        currentPair.current = created;
        setPair(created);
      } else
        void loginRequest("/auth/browser-login/cancel", proof(created)).catch(
          () => {},
        );
    } catch (caught) {
      if (isCurrent())
        setError(caught instanceof Error ? caught.message : "发起失败");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function checkWechat() {
    if (busy || !pair) return;
    const pending = pair;
    const isCurrent = requests.begin();
    setBusy(true);
    setError("");
    try {
      const result = await loginRequest<{ status: string }>(
        "/auth/browser-login/poll",
        proof(pending),
      );
      if (!isCurrent()) return;
      if (result.status !== "APPROVED") {
        setError(
          result.status === "PENDING"
            ? "尚待小程序确认；请至少间隔两秒检查。"
            : "本次配对已结束，请取消后重新发起。",
        );
        return;
      }
      // A consumed claim is never retried to mint another browser session.
      const session = await loginRequest<AuthSession>(
        "/auth/browser-login/claim",
        proof(pending),
      );
      await deliver(session, isCurrent);
    } catch (caught) {
      if (isCurrent())
        setError(
          caught instanceof Error
            ? caught.message
            : "登录未确认，请重新发起配对",
        );
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function startPassword() {
    if (busy || !passwordConfig?.enabled || !passwordConfig.smsEnabled) return;
    const isCurrent = requests.begin();
    const suppliedPassword = password;
    setPassword("");
    setBusy(true);
    setError("");
    try {
      const created = await loginRequest<PasswordChallenge>(
        "/auth/staff-password/login",
        { account: account.trim(), password: suppliedPassword },
      );
      if (isCurrent()) setChallenge(created);
    } catch (caught) {
      if (isCurrent())
        setError(caught instanceof Error ? caught.message : "账号密码验证失败");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function confirmSms() {
    if (busy || !challenge || !/^\d{6}$/.test(smsCode)) return;
    const pending = challenge;
    const isCurrent = requests.begin();
    const suppliedCode = smsCode;
    setSmsCode("");
    setBusy(true);
    setError("");
    try {
      const session = await loginRequest<AuthSession>(
        "/auth/staff-password/confirm",
        {
          challengeId: pending.challengeId,
          challengeSecret: pending.challengeSecret,
          code: suppliedCode,
        },
      );
      await deliver(session, isCurrent);
    } catch (caught) {
      if (isCurrent())
        setError(caught instanceof Error ? caught.message : "短信验证失败");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  return (
    <section className="catalog-workspace browser-login" aria-label="后台登录">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">SECURE SIGN IN</span>
          <h2>登录管理后台</h2>
          <p>
            仅限已授权工作人员。微信登录为主方式，账号密码登录须验证本人手机号。
          </p>
        </div>
      </div>
      <div className="login-methods" role="tablist" aria-label="选择登录方式">
        <button
          role="tab"
          aria-selected={method === "wechat"}
          className={method === "wechat" ? "active" : ""}
          onClick={() => {
            if (method !== "wechat") resetAttempt("wechat");
          }}
        >
          <strong>
            微信登录 <em>主方式</em>
          </strong>
          <span>小程序确认身份 + 动态码</span>
        </button>
        <button
          role="tab"
          aria-selected={method === "password"}
          className={method === "password" ? "active" : ""}
          onClick={() => {
            if (method !== "password") resetAttempt("password");
          }}
        >
          <strong>账号密码登录</strong>
          <span>管理员手机号 + 短信二次验证</span>
        </button>
      </div>
      {configError && (
        <p className="catalog-error" role="alert">
          {configError}
        </p>
      )}
      {error && (
        <p className="catalog-error" role="alert">
          {error}
        </p>
      )}
      <div
        className="login-form"
        role="tabpanel"
        aria-label={method === "wechat" ? "微信登录" : "账号密码登录"}
      >
        {method === "wechat" ? (
          <>
            {wechatConfig?.provider === "mock" && (
              <div className="catalog-error">
                当前为隔离 Mock 验收，不是真实微信登录；不得用于正式经营。
              </div>
            )}
            {!wechatConfig ? (
              <p>正在读取微信登录配置…</p>
            ) : !wechatConfig.enabled ? (
              <p>微信登录交接尚未开放，请等待管理员完成受控配置和验收。</p>
            ) : !pair ? (
              <button
                className="primary-action"
                disabled={busy}
                onClick={() => void startWechat()}
              >
                发起微信后台登录
              </button>
            ) : (
              <>
                <p>
                  工作人员请打开小程序专用「后台登录确认」页，输入以下配对码：
                </p>
                <code className="login-pair-code">{pair.pairCode}</code>
                <p>
                  在小程序核对六位数字：<strong>{pair.confirmationCode}</strong>
                </p>
                <p>
                  三分钟内有效，到期时间：
                  {new Date(pair.expiresAt).toLocaleTimeString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                  })}
                </p>
                <div className="catalog-actions">
                  <button
                    className="primary-action"
                    disabled={busy}
                    onClick={() => void checkWechat()}
                  >
                    我已在小程序确认
                  </button>
                  <button
                    className="ghost-action"
                    onClick={() => resetAttempt("wechat")}
                  >
                    取消本次登录
                  </button>
                </div>
              </>
            )}
          </>
        ) : !passwordConfig ? (
          <p>正在读取账号密码登录配置…</p>
        ) : !passwordConfig.enabled || !passwordConfig.smsEnabled ? (
          <p>
            账号密码与短信登录尚未启用。请先使用微信登录；后台完成短信通道验收后开放。
          </p>
        ) : challenge ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void confirmSms();
            }}
          >
            <p>
              验证码已发送至绑定手机号 <strong>{challenge.maskedPhone}</strong>
              。
            </p>
            <p>
              有效至{" "}
              {new Date(challenge.expiresAt).toLocaleTimeString("zh-CN", {
                timeZone: "Asia/Shanghai",
              })}
              。再次发送须遵守服务端限流（至少 {challenge.retryAfterSeconds}{" "}
              秒）。
            </p>
            <label>
              短信验证码
              <input
                type="password"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={smsCode}
                onChange={(event) =>
                  setSmsCode(event.target.value.replace(/\D/g, ""))
                }
              />
            </label>
            <div className="catalog-actions">
              <button
                type="submit"
                className="primary-action"
                disabled={busy || !/^\d{6}$/.test(smsCode)}
              >
                验证并登录
              </button>
              <button
                type="button"
                className="ghost-action"
                onClick={() => resetAttempt("password")}
              >
                重新输入账号密码
              </button>
            </div>
          </form>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void startPassword();
            }}
          >
            <label>
              已绑定手机号
              <input
                type="tel"
                inputMode="tel"
                autoComplete="username"
                maxLength={11}
                value={account}
                onChange={(event) =>
                  setAccount(event.target.value.replace(/\D/g, ""))
                }
              />
            </label>
            <label>
              账号密码
              <input
                type="password"
                autoComplete="off"
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <p>
              首次设置密码须先微信登录，在「账户安全」完成新的动态码验证。不会创建新用户或增加管理权限。
            </p>
            <button
              type="submit"
              className="primary-action"
              disabled={busy || !/^1[3-9]\d{9}$/.test(account) || !password}
            >
              验证密码并发送短信
            </button>
          </form>
        )}
      </div>
      <p className="login-security-note">
        请仅在自己打开的电脑上登录。不接受他人配对码，不向客服提供密码、短信验证码、令牌或动态码。已登记的常用设备可在
        7 天内免登录动态码；审核、发布、资金及账号安全操作仍须新的动态码。
      </p>
    </section>
  );
}
