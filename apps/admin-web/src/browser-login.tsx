import { authenticatedFetch } from "./authenticated-fetch";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthSession } from "@zydj/contracts";
import { createLoginGeneration, deliverBrowserSession } from "./login-state";
import { StaffFirstPasswordSetup } from "./staff-first-password-setup";
import {
  currentStaffPasswordChallenge,
  isValidStaffLoginAccount,
  normalizeStaffLoginAccount,
} from "./staff-login-account";
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
type LoginMethod = "wechat" | "password" | "setup";
const LOGIN_TIMEOUT_MS = 15_000;
const RESPONSE_FORMAT_ERROR =
  "登录服务响应格式异常，请稍后重试；仍失败请联系管理员。";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function httpFailure(status: number) {
  return status === 503
    ? "登录服务暂时无法访问（HTTP 503）。当前网络可能未获准访问后台，或服务暂时不可用；请稍后重试，仍失败请联系管理员。"
    : `登录请求失败（HTTP ${status}），请稍后重试；仍失败请联系管理员。`;
}

function httpError(status: number, message = httpFailure(status)) {
  return Object.assign(Error(message), { status });
}

function transportFailure(caught: unknown, signal: AbortSignal) {
  const name = (caught as { name?: unknown } | null)?.name;
  return Error(
    signal.aborted || name === "TimeoutError" || name === "AbortError"
      ? "登录请求超时，请检查网络后重试；不会自动重复提交。"
      : "登录网络连接失败，请检查网络后重试；仍失败请联系管理员。",
  );
}

function validWechatPair(value: unknown): value is Pair {
  // Workstation clocks can be skewed; actual expiry is enforced by the server.
  return (
    isRecord(value) &&
    typeof value.pairCode === "string" &&
    /^[A-Za-z0-9_-]{22}$/.test(value.pairCode) &&
    typeof value.browserSecret === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.browserSecret) &&
    typeof value.confirmationCode === "string" &&
    /^\d{6}$/.test(value.confirmationCode) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt))
  );
}

export async function loginRequest<T>(
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const signal = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
  let response: Response;
  try {
    response = await authenticatedFetch(token, `${API_BASE_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      credentials: "include",
      signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (caught) {
    throw transportFailure(caught, signal);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (caught) {
    const name = (caught as { name?: unknown } | null)?.name;
    if (signal.aborted || name === "TimeoutError" || name === "AbortError")
      throw Object.assign(transportFailure(caught, signal), {
        status: response.status,
      });
    if (!response.ok) throw httpError(response.status);
    throw Error(RESPONSE_FORMAT_ERROR);
  }
  if (!response.ok)
    throw httpError(
      response.status,
      isRecord(json) && typeof json.message === "string" && json.message.trim()
        ? json.message
        : httpFailure(response.status),
    );
  // An HTML fallback or absent envelope must never look like an empty success.
  if (!isRecord(json) || !Object.hasOwn(json, "data") || json.data == null)
    throw Error(RESPONSE_FORMAT_ERROR);
  return json.data as T;
}
const proof = (pair: Pair) => ({
  pairCode: pair.pairCode,
  browserSecret: pair.browserSecret,
});
const revoke = async (session: AuthSession) => {
  await loginRequest("/auth/logout", {}, session.accessToken).catch(() => {});
};

export function StaffPasswordCredentialsFields({
  account,
  password,
  busy,
  onAccountChange,
  onPasswordChange,
}: {
  account: string;
  password: string;
  busy: boolean;
  onAccountChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
}) {
  return (
    <>
      <label>
        登录账号
        <input
          type="text"
          inputMode="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={32}
          aria-describedby="staff-password-format"
          value={account}
          placeholder="用户名或已绑定手机号"
          onChange={(event) => onAccountChange(event.target.value)}
        />
      </label>
      <label>
        账号密码
        <input
          type="password"
          autoComplete="off"
          minLength={12}
          maxLength={128}
          value={password}
          disabled={busy}
          aria-describedby="staff-password-format"
          onChange={(event) => onPasswordChange(event.target.value)}
        />
      </label>
    </>
  );
}

export function BrowserLogin({
  onSession,
}: {
  onSession: (session: AuthSession) => void;
}) {
  const [method, setMethod] = useState<LoginMethod>("password");
  const [wechatConfig, setWechatConfig] = useState<{
    enabled: boolean;
    provider: string;
  } | null>(null);
  const [passwordConfig, setPasswordConfig] = useState<{
    enabled: boolean;
    smsEnabled: boolean;
    setupEnabled?: boolean;
  } | null>(null);
  const [configError, setConfigError] = useState("");
  const [pair, setPair] = useState<Pair | null>(null);
  const [wechatRestartRequired, setWechatRestartRequired] = useState(false);
  const [challenge, setChallenge] = useState<PasswordChallenge | null>(null);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState("");
  const [smsRetryAt, setSmsRetryAt] = useState(0);
  const [smsNow, setSmsNow] = useState(Date.now());
  const requests = useMemo(createLoginGeneration, []);
  const currentPair = useRef<Pair | null>(null);
  currentPair.current = pair;
  const currentMethod = useRef(method);
  currentMethod.current = method;
  const operationBusy = useRef(false);
  const setupScope = useRef<() => boolean>(() => false);
  const setupRetryDeadline = useRef(0);
  const setupEnabled = Boolean(
    passwordConfig?.enabled === true &&
      passwordConfig.smsEnabled === true &&
      passwordConfig.setupEnabled === true,
  );
  const setupIsCurrent = setupScope.current;
  const smsRetrySeconds = Math.max(0, Math.ceil((smsRetryAt - smsNow) / 1000));
  function setSmsCooldown(deadline: number) {
    setupRetryDeadline.current = deadline;
    setSmsRetryAt(deadline);
    setSmsNow(Date.now());
  }
  function setBusy(value: boolean) {
    operationBusy.current = value;
    setBusyState(value);
  }
  const passwordDisabledReason = busy
    ? "正在验证密码并提交短信请求，请稍候，不要重复点击。"
    : smsRetrySeconds > 0
      ? `请等待 ${smsRetrySeconds} 秒后再申请短信验证码。`
      : !account.trim()
        ? "请先输入本人设置的用户名或已绑定的11位手机号。"
        : !isValidStaffLoginAccount(account)
          ? "账号格式不正确，请使用已绑定的11位手机号或符合下方规则的用户名。"
          : password.length < 12
            ? "密码至少12位；六位短信验证码或验证器动态码不能当作登录密码。"
            : password.length > 128
              ? "密码不能超过128位，请重新输入本人已设置的密码。"
              : "";

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
    void loginRequest<{
      enabled: boolean;
      smsEnabled: boolean;
      setupEnabled?: boolean;
    }>("/auth/staff-password/config")
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

  useEffect(() => {
    if (!smsRetryAt) return;
    const timer = setInterval(() => {
      const value = Date.now();
      setSmsNow(value);
      if (value >= smsRetryAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [smsRetryAt]);

  function resetAttempt(nextMethod: LoginMethod) {
    requests.invalidate();
    currentMethod.current = nextMethod;
    setupScope.current =
      nextMethod === "setup" ? requests.begin() : () => false;
    const pending = currentPair.current;
    currentPair.current = null;
    setPair(null);
    setWechatRestartRequired(false);
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
  function clearFinishedWechatAttempt() {
    currentPair.current = null;
    setPair(null);
    setWechatRestartRequired(true);
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
    if (
      currentMethod.current !== "wechat" ||
      operationBusy.current ||
      pair ||
      !wechatConfig?.enabled
    )
      return;
    const isCurrent = requests.begin();
    setBusy(true);
    setError("");
    try {
      const created = await loginRequest<unknown>(
        "/auth/browser-login/create",
        {},
      );
      if (!validWechatPair(created)) throw Error(RESPONSE_FORMAT_ERROR);
      if (isCurrent()) {
        currentPair.current = created;
        setPair(created);
        setWechatRestartRequired(false);
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
    if (currentMethod.current !== "wechat" || operationBusy.current || !pair)
      return;
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
      if (result.status === "PENDING") {
        setError("尚待小程序确认；请至少间隔两秒检查。");
        return;
      }
      if (["CONSUMED", "CANCELLED", "EXPIRED"].includes(result.status)) {
        clearFinishedWechatAttempt();
        setError("本次配对已结束，请点击下方「重新发起微信后台登录」。");
        return;
      }
      if (result.status !== "APPROVED") throw Error(RESPONSE_FORMAT_ERROR);
      // A consumed claim is never retried to mint another browser session.
      const session = await loginRequest<AuthSession>(
        "/auth/browser-login/claim",
        proof(pending),
      );
      await deliver(session, isCurrent);
    } catch (caught) {
      if (isCurrent()) {
        const status = (caught as { status?: unknown } | null)?.status;
        if (status === 401 || status === 409) clearFinishedWechatAttempt();
        setError(
          caught instanceof Error
            ? caught.message
            : "登录未确认，请重新发起配对",
        );
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function startPassword() {
    if (
      currentMethod.current !== "password" ||
      operationBusy.current ||
      Date.now() < setupRetryDeadline.current ||
      !passwordConfig?.enabled ||
      !passwordConfig.smsEnabled ||
      !isValidStaffLoginAccount(account) ||
      password.length < 12 ||
      password.length > 128
    )
      return;
    const isCurrent = requests.begin();
    const suppliedAccount = normalizeStaffLoginAccount(account);
    const suppliedPassword = password;
    setPassword("");
    setBusy(true);
    setError("");
    try {
      const created = await currentStaffPasswordChallenge(
        () =>
          loginRequest<PasswordChallenge>("/auth/staff-password/login", {
            account: suppliedAccount,
            password: suppliedPassword,
          }),
        isCurrent,
      );
      if (created && isCurrent()) {
        setChallenge(created);
        const wait =
          Number.isInteger(created.retryAfterSeconds) &&
          created.retryAfterSeconds >= 1 &&
          created.retryAfterSeconds <= 3600
            ? created.retryAfterSeconds
            : 60;
        setSmsCooldown(Date.now() + wait * 1000);
      }
    } catch (caught) {
      if (isCurrent())
        setError(caught instanceof Error ? caught.message : "账号密码验证失败");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function confirmSms() {
    if (
      currentMethod.current !== "password" ||
      operationBusy.current ||
      !challenge ||
      !/^\d{6}$/.test(smsCode)
    )
      return;
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
            仅限已授权工作人员。默认使用账号密码加本人手机短信登录，微信登录保留为备用方式。
          </p>
        </div>
      </div>
      <div className="login-methods" role="tablist" aria-label="选择登录方式">
        <button
          role="tab"
          aria-selected={method !== "wechat"}
          className={method !== "wechat" ? "active" : ""}
          onClick={() => {
            if (method !== "password") resetAttempt("password");
          }}
        >
          <strong>
            账号密码登录 <em>默认方式</em>
          </strong>
          <span>用户名或手机号 + 本人手机短信</span>
        </button>
        <button
          role="tab"
          aria-selected={method === "wechat"}
          className={method === "wechat" ? "active" : ""}
          onClick={() => {
            if (method !== "wechat") resetAttempt("wechat");
          }}
        >
          <strong>
            微信登录 <em>备用方式</em>
          </strong>
          <span>小程序确认身份 + 动态码</span>
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
        aria-label={
          method === "wechat"
            ? "微信登录"
            : method === "setup"
              ? "首次设置账号密码"
              : "账号密码登录"
        }
      >
        {method === "password" && !challenge && (
          <aside className="environment-banner" role="note">
            <strong>尚未设置过登录密码？</strong>
            <p>
              已授权工作人员可用本人已绑定手机号验证后，手动首次设置用户名和密码。
              不注册新账号、不重置已有密码、不增加权限，无需先进行微信配对。
            </p>
            <button
              type="button"
              className="ghost-action"
              disabled={busy || !setupEnabled}
              onClick={() => {
                if (!operationBusy.current && setupEnabled)
                  resetAttempt("setup");
              }}
            >
              首次设置账号密码
            </button>
            {passwordConfig && !setupEnabled && (
              <p>
                首次设置账号密码尚未启用，请联系管理员；已有账号可继续正常登录。
              </p>
            )}
          </aside>
        )}
        {method === "setup" ? (
          <StaffFirstPasswordSetup
            enabled={setupEnabled}
            isParentCurrent={() =>
              currentMethod.current === "setup" && setupIsCurrent()
            }
            retryDeadline={setupRetryDeadline}
            onCooldown={setSmsCooldown}
            request={loginRequest}
            onSession={deliver}
            onCancel={() => resetAttempt("password")}
          />
        ) : method === "wechat" ? (
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
                {wechatRestartRequired
                  ? "重新发起微信后台登录"
                  : "发起微信后台登录"}
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
              短信验证请求已提交，绑定手机号{" "}
              <strong>{challenge.maskedPhone}</strong>
              。请以手机实际收到为准，暂未收到时请勿连续重复申请。
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
            <StaffPasswordCredentialsFields
              account={account}
              password={password}
              busy={busy}
              onAccountChange={(value) => {
                resetAttempt("password");
                setAccount(value);
              }}
              onPasswordChange={setPassword}
            />
            <p id="staff-password-format">
              账号可填写已绑定的11位手机号，或本人设置的4–32位用户名（字母开头，仅英文字母、数字、下划线或短横线）。
              密码必须为12–128个字符，不是六位短信验证码或验证器动态码。
            </p>
            <p>
              可使用本人设置的用户名或原已绑定手机号登录；密码验证后仍需向本人绑定手机发送短信二次验证。
              尚未设置密码的已授权工作人员可使用上方首次设置入口；修改已有密码仍须在「账户安全」完成新的动态码验证。不会创建新用户或增加管理权限。
            </p>
            <button
              type="submit"
              className="primary-action"
              aria-describedby={
                passwordDisabledReason
                  ? "staff-password-submit-reason"
                  : "staff-password-format"
              }
              disabled={
                busy ||
                smsRetrySeconds > 0 ||
                !isValidStaffLoginAccount(account) ||
                password.length < 12 ||
                password.length > 128
              }
            >
              验证密码并发送短信
            </button>
            {passwordDisabledReason && (
              <p
                id="staff-password-submit-reason"
                role="status"
                aria-live="polite"
              >
                {passwordDisabledReason}
              </p>
            )}
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
