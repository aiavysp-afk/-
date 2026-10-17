import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { AuthSessionSchema, type AuthSession } from "@zydj/contracts";
import { createLoginGeneration } from "./login-state";
import {
  buildStaffSetupConfirmation,
  isValidStaffSetupPhone,
  normalizeStaffSetupPhone,
  parseStaffSetupChallenge,
  type StaffSetupChallenge,
  type StaffSetupDraft,
} from "./staff-first-password";

type Props = {
  enabled: boolean;
  isParentCurrent: () => boolean;
  retryDeadline: MutableRefObject<number>;
  onCooldown?: (deadline: number) => void;
  request: <T>(path: string, body?: unknown, token?: string) => Promise<T>;
  onSession: (
    session: AuthSession,
    isCurrent: () => boolean,
  ) => Promise<unknown>;
  onCancel: () => void;
};
const blankDraft = (): StaffSetupDraft => ({
  code: "",
  loginAlias: "",
  password: "",
  confirmation: "",
});

export function StaffFirstPasswordSetup({
  enabled,
  isParentCurrent,
  retryDeadline,
  onCooldown,
  request,
  onSession,
  onCancel,
}: Props) {
  const [phone, setPhone] = useState("");
  const [challenge, setChallenge] = useState<StaffSetupChallenge | null>(null);
  const [draft, setDraft] = useState(blankDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [retryAt, setRetryAt] = useState(retryDeadline.current);
  const [now, setNow] = useState(Date.now());
  const requests = useMemo(createLoginGeneration, []);
  const currentChallenge = useRef(challenge);
  currentChallenge.current = challenge;
  const currentContext = useRef({
    enabled,
    isParentCurrent,
    phone,
    mounted: true,
  });
  currentContext.current = {
    enabled,
    isParentCurrent,
    phone,
    mounted: currentContext.current.mounted,
  };
  const operationBusy = useRef(false);
  const retrySeconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const canConfirm = Boolean(
    enabled &&
      challenge &&
      !busy &&
      !uncertain &&
      buildStaffSetupConfirmation(challenge, draft),
  );
  function active() {
    const context = currentContext.current;
    return context.mounted && context.enabled && context.isParentCurrent();
  }
  function begin() {
    const latest = requests.begin();
    const identityPhone = currentContext.current.phone;
    return () =>
      latest() && active() && currentContext.current.phone === identityPhone;
  }
  function clearProof() {
    currentChallenge.current = null;
    setChallenge(null);
    setDraft(blankDraft());
  }
  function setOperationBusy(value: boolean) {
    operationBusy.current = value;
    setBusy(value);
  }
  function cooldown(seconds: number) {
    const deadline = Date.now() + seconds * 1000;
    retryDeadline.current = deadline;
    onCooldown?.(deadline);
    setRetryAt(deadline);
    setNow(Date.now());
  }
  function changePhone(value: string) {
    requests.invalidate();
    currentContext.current.phone = value;
    clearProof();
    setPhone(value);
    setError("");
    setUncertain(false);
    setOperationBusy(false);
  }
  useEffect(() => {
    currentContext.current.mounted = true;
    return () => {
      currentContext.current.mounted = false;
      requests.invalidate();
      currentChallenge.current = null;
      operationBusy.current = false;
    };
  }, [requests]);
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => {
      const value = Date.now();
      setNow(value);
      if (value >= retryAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  useEffect(() => {
    if (!enabled) {
      requests.invalidate();
      clearProof();
      setOperationBusy(false);
    }
  }, [enabled, requests]);

  async function sendCode() {
    if (
      !active() ||
      operationBusy.current ||
      !isValidStaffSetupPhone(currentContext.current.phone) ||
      Date.now() < retryDeadline.current
    )
      return;
    const isCurrent = begin();
    const suppliedPhone = normalizeStaffSetupPhone(
      currentContext.current.phone,
    );
    clearProof();
    setError("");
    setUncertain(false);
    setOperationBusy(true);
    // A timed-out request may already have submitted an SMS. Never auto-resend;
    // retain a conservative local cooldown even when its result is unknown.
    cooldown(60);
    try {
      const value = await request<unknown>(
        "/auth/staff-password/setup/request",
        { phone: suppliedPhone },
      );
      const created = parseStaffSetupChallenge(value);
      if (!created)
        throw Error("首次设置响应格式异常，请稍后重试或联系管理员。");
      if (!isCurrent()) return;
      currentChallenge.current = created;
      setChallenge(created);
      cooldown(created.retryAfterSeconds);
    } catch (caught) {
      if (isCurrent())
        setError(
          caught instanceof Error
            ? caught.message
            : "验证码请求未确认，请稍后重试。",
        );
    } finally {
      if (isCurrent()) setOperationBusy(false);
    }
  }
  async function confirmSetup() {
    if (!active() || operationBusy.current || uncertain) return;
    const payload = buildStaffSetupConfirmation(
      currentChallenge.current,
      draft,
    );
    if (!payload) return;
    const isCurrent = begin();
    setDraft((previous) => ({
      ...previous,
      code: "",
      password: "",
      confirmation: "",
    }));
    setError("");
    setOperationBusy(true);
    try {
      const raw = await request<unknown>(
        "/auth/staff-password/setup/confirm",
        payload,
      );
      const parsed = AuthSessionSchema.safeParse(raw);
      if (!parsed.success)
        throw Error("首次设置结果格式异常，请改用账号密码登录检查。");
      if (isCurrent()) clearProof();
      // Always deliver even a late session: the existing delivery workflow
      // revokes obsolete sessions rather than accepting them or their trust cookie.
      await onSession(parsed.data, isCurrent);
    } catch (caught) {
      if (isCurrent()) {
        const status = (caught as { status?: unknown } | null)?.status;
        if (typeof status !== "number" || status >= 500) {
          clearProof();
          setUncertain(true);
        }
        setError(
          caught instanceof Error ? caught.message : "首次设置未确认，请重试。",
        );
      }
    } finally {
      if (isCurrent()) setOperationBusy(false);
    }
  }

  return (
    <section aria-label="首次设置账号密码">
      <h3>首次设置账号密码</h3>
      <p>
        仅限手机号已绑定的现有授权工作人员。此流程只首次设置密码，不注册新账号、不重置已有密码、不增加权限；全程由本人手动操作。
      </p>
      {!enabled ? (
        <p role="status">
          首次设置账号密码尚未启用，请联系管理员；已有账号仍可正常登录。
        </p>
      ) : (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void sendCode();
            }}
          >
            <label>
              本人已绑定手机号
              <input
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                maxLength={11}
                value={phone}
                placeholder="请输入11位手机号"
                onChange={(event) =>
                  changePhone(
                    event.target.value.replace(/\D/g, "").slice(0, 11),
                  )
                }
              />
            </label>
            <p>
              若号码符合现有授权账号的首次设置条件，将收到验证码；请求已提交不代表短信已送达，请以手机实际收到为准。
            </p>
            <button
              type="submit"
              className="primary-action"
              disabled={
                busy || !isValidStaffSetupPhone(phone) || retrySeconds > 0
              }
            >
              {retrySeconds > 0
                ? `请等待 ${retrySeconds} 秒后再发送`
                : challenge
                  ? "重新发送首次设置验证码"
                  : "发送首次设置验证码"}
            </button>
          </form>
          {challenge && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void confirmSetup();
              }}
            >
              <p>
                验证码请求已提交至符合条件的绑定手机号{" "}
                <strong>{challenge.maskedPhone}</strong>，不保证送达。有效至{" "}
                {new Date(challenge.expiresAt).toLocaleTimeString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })}
                ，有效性由服务器校验；过期后请手动重新发送。
              </p>
              <label>
                短信验证码
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={draft.code}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      code: event.target.value.replace(/\D/g, "").slice(0, 6),
                    })
                  }
                />
              </label>
              <label>
                设置登录用户名
                <input
                  type="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  minLength={4}
                  maxLength={32}
                  value={draft.loginAlias}
                  disabled={busy}
                  placeholder="4–32位，以字母开头"
                  onChange={(event) =>
                    setDraft({ ...draft, loginAlias: event.target.value })
                  }
                />
              </label>
              <p>
                用户名为4–32位，以字母开头，可使用英文字母、数字、下划线或短横线，提交时规范为小写。
              </p>
              <label>
                设置新密码
                <input
                  type="password"
                  autoComplete="off"
                  minLength={12}
                  maxLength={128}
                  value={draft.password}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({ ...draft, password: event.target.value })
                  }
                />
              </label>
              <label>
                再次输入新密码
                <input
                  type="password"
                  autoComplete="off"
                  minLength={12}
                  maxLength={128}
                  value={draft.confirmation}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({ ...draft, confirmation: event.target.value })
                  }
                />
              </label>
              <p>
                密码须12–128个字符，两次填写一致。短信验证码和验证器动态码不是登录密码。提交成功后直接进入本人原有后台账号，敏感操作仍需独立验证器动态码。
              </p>
              <button
                type="submit"
                className="primary-action"
                disabled={!canConfirm}
              >
                本人确认设置密码并登录
              </button>
            </form>
          )}
          {uncertain && (
            <p role="status">
              本次提交结果未确认，可能已经完成设置。请先返回账号密码登录检查，不要重复设置；本页不会自动重试或重发短信。
            </p>
          )}
        </>
      )}
      {error && (
        <p className="catalog-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="ghost-action"
        onClick={() => {
          requests.invalidate();
          currentChallenge.current = null;
          onCancel();
        }}
      >
        返回账号密码登录
      </button>
    </section>
  );
}
