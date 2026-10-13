import { useEffect, useMemo, useRef, useState } from "react";
import { createLoginGeneration, hasFreshTotp } from "./login-state";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
type PasswordState = {
  configured: boolean;
  maskedAccount: string | null;
  changedAt?: string | null;
};
type TrustConfig = { enabled: boolean; maxDays: number };
type TrustedDevice = {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string | null;
  current?: boolean;
  revokedAt?: string | null;
};
const localDate = (date: string) =>
  new Date(date).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

export function StaffSecurity({
  token,
  verifiedUntil,
  onSecurityChange,
}: {
  token: string;
  verifiedUntil: string | null;
  onSecurityChange?: () => Promise<void>;
}) {
  const [passwordState, setPasswordState] = useState<PasswordState | null>(
    null,
  );
  const [passwordConfig, setPasswordConfig] = useState<{
    enabled: boolean;
    smsEnabled: boolean;
  } | null>(null);
  const [trustConfig, setTrustConfig] = useState<TrustConfig | null>(null);
  const [devices, setDevices] = useState<TrustedDevice[] | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [privateDevice, setPrivateDevice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(Date.now());
  const requests = useMemo(createLoginGeneration, []);
  const currentToken = useRef(token);
  currentToken.current = token;
  const freshTotp = hasFreshTotp({ verifiedUntil }, now);

  async function request<T>(
    path: string,
    body?: unknown,
    method: "POST" | "PUT" = "POST",
  ) {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: body === undefined ? "GET" : method,
      credentials: "include",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Error(
        typeof json.message === "string" ? json.message : "账户安全请求失败",
      );
    return json.data as T;
  }
  async function load(isCurrent: () => boolean) {
    setPasswordState(null);
    setDevices(null);
    setError("");
    try {
      const [passwordData, passwordFeature, trustFeature] = await Promise.all([
        request<PasswordState>("/auth/staff-password"),
        request<{ enabled: boolean; smsEnabled: boolean }>(
          "/auth/staff-password/config",
        ),
        request<TrustConfig>("/auth/trusted-devices/config"),
      ]);
      // Revocation/listing remains available while trust enrollment is disabled.
      const trusted = await request<TrustedDevice[]>("/auth/trusted-devices");
      if (!isCurrent()) return;
      setPasswordState(passwordData);
      setPasswordConfig(passwordFeature);
      setTrustConfig(trustFeature);
      setDevices(trusted);
    } catch (caught) {
      if (isCurrent()) {
        setPasswordState(null);
        setPasswordConfig(null);
        setTrustConfig(null);
        setDevices(null);
        setError(
          caught instanceof Error ? caught.message : "账户安全配置读取失败",
        );
      }
    }
  }
  useEffect(() => {
    setPassword("");
    setConfirmation("");
    setDeviceLabel("");
    setPrivateDevice(false);
    setMessage("");
    setBusy(false);
    const isCurrent = requests.begin();
    void load(isCurrent);
    return () => requests.invalidate();
  }, [token, verifiedUntil, requests]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function savePassword() {
    if (
      busy ||
      !passwordConfig?.enabled ||
      !hasFreshTotp({ verifiedUntil }) ||
      !passwordState?.maskedAccount ||
      password.length < 12 ||
      password.length > 128 ||
      password !== confirmation
    )
      return;
    const isCurrent = requests.begin();
    const suppliedPassword = password;
    setPassword("");
    setConfirmation("");
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await request(
        "/auth/staff-password",
        { password: suppliedPassword },
        "PUT",
      );
      if (!isCurrent()) return;
      setMessage(
        "密码已更新，其他后台会话与全部常用设备信任已撤销。当前动态码验证只在原有效期内保留，常用设备需要重新验证并登记。",
      );
      await load(isCurrent);
      if (isCurrent()) await onSecurityChange?.();
    } catch (caught) {
      if (isCurrent())
        setError(caught instanceof Error ? caught.message : "设置密码失败");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function registerDevice() {
    if (
      busy ||
      !hasFreshTotp({ verifiedUntil }) ||
      !trustConfig?.enabled ||
      !privateDevice
    )
      return;
    const isCurrent = requests.begin();
    setError("");
    setMessage("");
    setBusy(true);
    try {
      const result = await request<{ device: TrustedDevice }>(
        "/auth/trusted-devices",
        { ...(deviceLabel.trim() ? { label: deviceLabel.trim() } : {}) },
      );
      if (!isCurrent()) return;
      setPrivateDevice(false);
      setDeviceLabel("");
      setMessage(
        `本设备已登记，有效至 ${localDate(result.device.expiresAt)}，不自动续期。`,
      );
      await load(isCurrent);
    } catch (caught) {
      if (isCurrent())
        setError(caught instanceof Error ? caught.message : "登记信任设备失败");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function revokeDevice(device: TrustedDevice) {
    if (
      busy ||
      !window.confirm(
        `确认撤销「${device.label || "常用设备"}」的信任？该设备以后登录需重新完成二次验证。`,
      )
    )
      return;
    const identity = token;
    const isCurrent = requests.begin();
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await request("/auth/trusted-devices/revoke", { id: device.id });
      if (!isCurrent() || currentToken.current !== identity) return;
      setMessage("该设备的信任已撤销。");
      await load(isCurrent);
      if (isCurrent()) await onSecurityChange?.();
    } catch (caught) {
      if (isCurrent())
        setError(caught instanceof Error ? caught.message : "撤销信任失败");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  return (
    <div className="staff-security">
      <section className="security-panel">
        <h3>账号密码与短信登录</h3>
        {passwordState ? (
          <>
            <p>
              已绑定手机号：
              <strong>{passwordState.maskedAccount || "未绑定"}</strong> ·
              密码：{passwordState.configured ? "已设置" : "未设置"}
            </p>
            {passwordState.changedAt && (
              <p>最近修改：{localDate(passwordState.changedAt)}</p>
            )}
            {(!passwordConfig?.enabled || !passwordConfig.smsEnabled) && (
              <p>
                账号密码短信登录尚未开放。仍可使用现有微信登录；开启后才可通过短信验证登录。
              </p>
            )}
            {!freshTotp && (
              <p className="security-step-up">
                设置或修改密码需要新的六位动态码。短信登录和信任设备不能代替本次敏感操作验证。
              </p>
            )}
            {!passwordState.maskedAccount && (
              <p>
                请先在小程序验证本人手机号，不能使用其他人的手机号设置账号密码。
              </p>
            )}
            <form
              className="login-form"
              onSubmit={(event) => {
                event.preventDefault();
                void savePassword();
              }}
            >
              <label>
                新密码
                <input
                  type="password"
                  autoComplete="off"
                  minLength={12}
                  maxLength={128}
                  value={password}
                  disabled={
                    !passwordConfig?.enabled ||
                    !freshTotp ||
                    busy ||
                    !passwordState.maskedAccount
                  }
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label>
                再次输入新密码
                <input
                  type="password"
                  autoComplete="off"
                  maxLength={128}
                  value={confirmation}
                  disabled={
                    !passwordConfig?.enabled ||
                    !freshTotp ||
                    busy ||
                    !passwordState.maskedAccount
                  }
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
              <p>
                12–128
                个字符，建议使用足够长且不与其他网站重复的密码。只由本人填写，不交给客服或工作人员。
              </p>
              <button
                className="primary-action"
                type="submit"
                disabled={
                  !passwordConfig?.enabled ||
                  !freshTotp ||
                  busy ||
                  !passwordState.maskedAccount ||
                  password.length < 12 ||
                  password !== confirmation
                }
              >
                {passwordState.configured ? "修改本人密码" : "设置本人密码"}
              </button>
            </form>
          </>
        ) : (
          <p>密码配置尚未读取成功，请重试；不代表未设置密码。</p>
        )}
      </section>
      <section className="security-panel">
        <h3>常用设备 · 7 天信任</h3>
        <p>
          只登记自己长期使用的私人电脑，公用或共享电脑不要信任。有效期从登记起计算，7
          天后自动失效，不自动续期；每次仍须完成微信或账号密码身份验证。
        </p>
        <p>
          信任仅免登录动态码，不扩大账号权限；审核、发布、资金及账号安全等敏感操作始终需要新的动态码。
        </p>
        {!trustConfig ? (
          <p>信任设备配置尚未读取成功。</p>
        ) : !trustConfig.enabled ? (
          <p>常用设备信任尚未启用，不会跳过动态码。</p>
        ) : (
          <>
            {!freshTotp && (
              <p className="security-step-up">
                登记设备前，请先完成新的六位动态码验证。
              </p>
            )}
            <div className="login-form">
              <label>
                设备备注（选填）
                <input
                  maxLength={80}
                  value={deviceLabel}
                  disabled={!freshTotp || busy}
                  onChange={(event) => setDeviceLabel(event.target.value)}
                  placeholder="例如：办公室私人电脑"
                />
              </label>
              <label className="trust-device-confirm">
                <input
                  type="checkbox"
                  checked={privateDevice}
                  disabled={!freshTotp || busy}
                  onChange={(event) => setPrivateDevice(event.target.checked)}
                />
                我确认这是本人的私人常用设备
              </label>
              <button
                className="primary-action"
                disabled={!freshTotp || busy || !privateDevice}
                onClick={() => void registerDevice()}
              >
                信任本设备 7 天
              </button>
            </div>
          </>
        )}
        {devices === null ? (
          <p>设备列表尚未读取成功，不能判定是否存在已登记设备。</p>
        ) : devices.filter((device) => !device.revokedAt).length ? (
          <div className="trusted-device-list">
            {devices
              .filter((device) => !device.revokedAt)
              .map((device) => (
                <article key={device.id}>
                  <div>
                    <strong>
                      {device.label || "常用设备"}
                      {device.current ? " · 当前设备" : ""}
                    </strong>
                    <p>
                      登记：{localDate(device.createdAt)} · 到期：
                      {localDate(device.expiresAt)}
                      {Date.parse(device.expiresAt) <= now ? "（已过期）" : ""}
                    </p>
                    {device.lastUsedAt && (
                      <p>最近使用：{localDate(device.lastUsedAt)}</p>
                    )}
                  </div>
                  <button
                    className="ghost-action"
                    disabled={busy}
                    onClick={() => void revokeDevice(device)}
                  >
                    撤销信任
                  </button>
                </article>
              ))}
          </div>
        ) : (
          <p>暂无已登记的信任设备。</p>
        )}
      </section>
      <button
        className="ghost-action"
        disabled={busy}
        onClick={() => void load(requests.begin())}
      >
        重新读取密码与设备配置
      </button>
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="catalog-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
