import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AuthSession } from "@zydj/contracts";
import { CheckCircle2, LoaderCircle, Smartphone } from "lucide-react";
import {
  ProfileForm,
  ReviewStatus,
  TechnicianMiniappEntry,
  TechnicianH5Onboarding,
} from "./h5-onboarding-page";
import type { H5CatalogService, H5OnboardingStatus } from "./h5-onboarding";
import {
  isTechnicianPhone,
  phoneOnboardingPaths,
  phoneWorkbenchAllowed,
  readPhoneToken,
  storePhoneToken,
  technicianRequest,
  validPhoneChallenge,
  type TechnicianPhoneCapabilities,
  type TechnicianPhoneChallenge,
} from "./phone-onboarding";

const PATHS = phoneOnboardingPaths();
const AGREEMENTS = [
  [
    "用户协议",
    "中原到家提供正规上门按摩、SPA及健康舒缓服务的预约与履约支持。请使用本人真实有效的手机号，不得冒用身份或转让账号。预约价格、时长、取消及售后规则以确认订单页面为准。平台禁止违法、色情、骚扰、暴力或超出正规健康服务范围的要求。",
  ],
  [
    "隐私政策",
    "仅为登录与入驻审核处理经验证的手机号、真实姓名、服务城市与区域、时段、简介、擅长项目、形象照及本人主动上传的身份证正反面。真实姓名和证件在服务端加密保存，仅供有权限的后台人员审核，不向客户公开。形象照和公开资料经审核发布后才展示。可以通过平台客服申请查询、更正或删除依法可处理的信息。",
  ],
  [
    "上门服务公约",
    "平台仅提供正规保健放松服务，非医疗服务，禁止违法违规内容。服务开始前须核验订单与人员，发现身份、环境或需求异常可中止并联系平台。双方须尊重职业边界，保护隐私；服务争议请保留订单与沟通记录，通过平台客服或售后入口处理。",
  ],
] as const;

export function TechnicianPhoneLogin({
  capabilities,
  loading,
  error,
  onRetry,
  onAuthenticated,
}: {
  capabilities: TechnicianPhoneCapabilities | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onAuthenticated: (session: AuthSession) => void;
}) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [challenge, setChallenge] = useState<TechnicianPhoneChallenge | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [agreement, setAgreement] = useState<number | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (!retryAt && !challenge) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (challenge && Date.parse(challenge.expiresAt) <= current) {
        generation.current++;
        busyRef.current = false;
        setBusy(false);
        setChallenge(null);
        setCode("");
        setFailure("本次验证码已过期，请手动重新获取");
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt, challenge]);
  const enabled = capabilities?.enabled === true;
  const countdown = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const invalidate = () => {
    generation.current++;
    busyRef.current = false;
    setBusy(false);
    setCode("");
    setChallenge(null);
    setNotice("");
    setFailure("");
  };
  async function sendCode() {
    if (
      busyRef.current ||
      !enabled ||
      !agreed ||
      !isTechnicianPhone(phone) ||
      Date.now() < retryAt
    )
      return;
    const attempt = ++generation.current;
    const current = () => mounted.current && generation.current === attempt;
    busyRef.current = true;
    setBusy(true);
    setFailure("");
    setNotice("");
    setCode("");
    setChallenge(null);
    // Reserve cooldown before the request: timeout is not proof that no SMS was sent.
    setRetryAt(Date.now() + 60_000);
    setNow(Date.now());
    try {
      const result = await technicianRequest<TechnicianPhoneChallenge>(
        PATHS.smsRequest,
        {
          method: "POST",
          body: JSON.stringify({ phone, agreementsAccepted: true }),
        },
      );
      if (!current()) return;
      if (!validPhoneChallenge(result))
        throw new Error("验证码凭据无效，请稍后手动重试");
      setChallenge(result);
      setRetryAt(Date.now() + Math.max(60, result.retryAfterSeconds) * 1000);
      setNotice(
        `验证码请求已受理，请查看 ${result.maskedPhone} 的短信；未收到可在倒计时后重试。`,
      );
    } catch (caught) {
      if (current())
        setFailure(
          caught instanceof Error
            ? caught.message
            : "验证码请求失败，请手动重试",
        );
    } finally {
      if (current()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function confirm() {
    if (
      busyRef.current ||
      !enabled ||
      !agreed ||
      !isTechnicianPhone(phone) ||
      !/^\d{6}$/.test(code) ||
      !challenge ||
      Date.parse(challenge.expiresAt) <= Date.now()
    )
      return;
    const attempt = ++generation.current;
    const current = () => mounted.current && generation.current === attempt;
    busyRef.current = true;
    setBusy(true);
    setFailure("");
    try {
      const session = await technicianRequest<AuthSession>(PATHS.smsConfirm, {
        method: "POST",
        body: JSON.stringify({
          phone,
          code,
          challengeId: challenge.challengeId,
          challengeSecret: challenge.challengeSecret,
          agreementsAccepted: true,
        }),
      });
      if (!current()) {
        if (session.accessToken)
          void technicianRequest(
            "/auth/logout",
            { method: "POST", body: "{}" },
            session.accessToken,
          ).catch(() => {});
        return;
      }
      if (!session.accessToken || typeof session.accessToken !== "string")
        throw new Error("服务器未返回有效登录会话，请重试");
      setChallenge(null);
      setCode("");
      onAuthenticated(session);
    } catch (caught) {
      if (!current()) return;
      setChallenge(null);
      setCode("");
      setFailure(
        caught instanceof Error
          ? caught.message
          : "验证未完成，请重新获取验证码",
      );
    } finally {
      if (current()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <main className="onboarding-main onboarding-phone">
      <section className="onboarding-hero">
        <div className="onboarding-hero-icon">
          <Smartphone />
        </div>
        <p>中原到家 · 技师入驻 / 登录</p>
        <h2>手机号验证，即可登记</h2>
        <span>无需密码 · 无需配对码 · 资料直达后台审核</span>
      </section>
      <section className="onboarding-phone-card" aria-label="技师手机号登录">
        <label className="onboarding-field">
          本人手机号
          <input
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            maxLength={11}
            value={phone}
            onChange={(event) => {
              invalidate();
              setPhone(event.currentTarget.value.replace(/\D/g, ""));
            }}
            placeholder="请输入11位手机号"
          />
        </label>
        <label className="onboarding-field onboarding-code-field">
          短信验证码
          <span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              disabled={!challenge || busy}
              onChange={(event) =>
                setCode(event.currentTarget.value.replace(/\D/g, ""))
              }
              placeholder="6位验证码"
            />
            <button
              type="button"
              disabled={
                busy ||
                loading ||
                !enabled ||
                !agreed ||
                !isTechnicianPhone(phone) ||
                countdown > 0
              }
              onClick={() => void sendCode()}
            >
              {countdown
                ? `${countdown}秒后重试`
                : busy
                  ? "请求中…"
                  : "获取验证码"}
            </button>
          </span>
        </label>
        <label className="onboarding-agreements">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(event) => {
              invalidate();
              setAgreed(event.currentTarget.checked);
            }}
          />
          <span>
            本人已阅读并同意
            {AGREEMENTS.map(([title], index) => (
              <React.Fragment key={title}>
                <button type="button" onClick={() => setAgreement(index)}>
                  《{title}》
                </button>
                {index < 2 ? "、" : ""}
              </React.Fragment>
            ))}
          </span>
        </label>
        {!agreed && (
          <p className="onboarding-hint">请本人勾选协议后获取验证码。</p>
        )}
        {!enabled && (
          <p className="onboarding-warning" role="status">
            {loading
              ? "正在检查手机号通道…"
              : "手机号入驻通道尚未开放，请联系平台；也可查看下方小程序入驻方式。"}
          </p>
        )}
        {(error || failure) && (
          <p className="onboarding-error" role="alert">
            {failure || error}
          </p>
        )}
        {notice && (
          <p className="onboarding-hint" role="status">
            {notice}
          </p>
        )}
        {!capabilities && !loading && (
          <button className="onboarding-secondary" onClick={onRetry}>
            重新检查通道
          </button>
        )}
        <button
          type="button"
          className="onboarding-primary"
          disabled={
            busy ||
            !enabled ||
            !agreed ||
            !isTechnicianPhone(phone) ||
            !challenge ||
            !/^\d{6}$/.test(code) ||
            Date.parse(challenge.expiresAt) <= now
          }
          onClick={() => void confirm()}
        >
          {busy && <LoaderCircle className="spinning" />}验证并进入入驻资料
        </button>
        <p className="onboarding-consent">
          新申请、待审核和已通过技师都使用本人同一手机号。待审核仅能查看和维护本人资料，不能接单。平台仅提供正规保健放松服务，非医疗服务。
        </p>
      </section>
      {agreement !== null && (
        <section
          className="onboarding-agreement-panel"
          role="dialog"
          aria-label={AGREEMENTS[agreement]![0]}
        >
          <h3>{AGREEMENTS[agreement]![0]}</h3>
          <p>{AGREEMENTS[agreement]![1]}</p>
          <button
            type="button"
            className="onboarding-secondary"
            onClick={() => setAgreement(null)}
          >
            关闭协议
          </button>
        </section>
      )}
    </main>
  );
}

export function TechnicianPhoneOnboarding({
  onWorkbench,
}: {
  onWorkbench: (token: string) => void;
}) {
  const [token, setToken] = useState(readPhoneToken);
  const tokenRef = useRef(token);
  const generation = useRef(0);
  const [capabilities, setCapabilities] =
    useState<TechnicianPhoneCapabilities | null>(null);
  const [status, setStatus] = useState<H5OnboardingStatus | null>(null);
  const [services, setServices] = useState<H5CatalogService[]>([]);
  const [loading, setLoading] = useState(Boolean(token));
  const [busy, setBusy] = useState(false);
  const [capLoading, setCapLoading] = useState(true);
  const registrationBusy = useRef(false);
  const [error, setError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [alternative, setAlternative] = useState<"miniapp" | "wechat" | null>(
    null,
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const clear = useCallback(() => {
    generation.current++;
    tokenRef.current = "";
    storePhoneToken("");
    setToken("");
    setStatus(null);
    setServices([]);
    setLoading(false);
    setBusy(false);
    registrationBusy.current = false;
    setError("");
    setCatalogError("");
    setCapabilities(null);
    setCapLoading(false);
  }, []);
  const loadCapabilities = useCallback(async () => {
    const attempt = generation.current;
    setCapLoading(true);
    try {
      const value = await technicianRequest<TechnicianPhoneCapabilities>(
        PATHS.capabilities,
      );
      if (!mounted.current || attempt !== generation.current) return;
      setCapabilities({
        enabled: value?.enabled === true,
        workbenchEnabled: value?.workbenchEnabled === true,
      });
    } catch (caught) {
      if (mounted.current && attempt === generation.current) {
        setCapabilities(null);
        setError(caught instanceof Error ? caught.message : "入驻通道读取失败");
      }
    } finally {
      if (mounted.current && attempt === generation.current)
        setCapLoading(false);
    }
  }, []);
  const loadCatalog = useCallback(async () => {
    const attempt = generation.current;
    const accessToken = tokenRef.current;
    setCatalogError("");
    try {
      const value = await technicianRequest<H5CatalogService[]>(PATHS.catalog);
      if (
        mounted.current &&
        generation.current === attempt &&
        tokenRef.current === accessToken
      )
        setServices(Array.isArray(value) ? value : []);
    } catch {
      if (
        mounted.current &&
        generation.current === attempt &&
        tokenRef.current === accessToken
      ) {
        setServices([]);
        setCatalogError("擅长项目暂未读取成功，请检查网络后重新读取。");
      }
    }
  }, []);
  const loadStatus = useCallback(
    async (accessToken = tokenRef.current) => {
      if (!accessToken) return;
      const attempt = ++generation.current;
      const current = () =>
        mounted.current &&
        attempt === generation.current &&
        tokenRef.current === accessToken;
      setLoading(true);
      setError("");
      setStatus(null);
      try {
        const [next, cap] = await Promise.all([
          technicianRequest<H5OnboardingStatus>(PATHS.status, {}, accessToken),
          technicianRequest<TechnicianPhoneCapabilities>(PATHS.capabilities),
        ]);
        if (!current()) return;
        setCapabilities({
          enabled: cap?.enabled === true,
          workbenchEnabled: cap?.workbenchEnabled === true,
        });
        setCapLoading(false);
        setStatus(next);
      } catch (caught) {
        if (!current()) return;
        const failure = caught as Error & { status?: number };
        if ([401, 403].includes(failure.status ?? 0)) {
          clear();
          setError("手机号会话已过期或权限已变化，请重新验证");
        } else setError(failure.message || "资料状态读取失败，请重试");
      } finally {
        if (current()) setLoading(false);
      }
    },
    [clear],
  );
  useEffect(() => {
    if (tokenRef.current) void loadStatus();
    else void loadCapabilities();
  }, [token, loadStatus, loadCapabilities]);
  useEffect(() => {
    if (
      token &&
      status &&
      ["PROFILE_REQUIRED", "REJECTED"].includes(status.stage)
    )
      void loadCatalog();
  }, [token, status?.stage, loadCatalog]);
  const authenticated = (session: AuthSession) => {
    generation.current++;
    tokenRef.current = session.accessToken;
    storePhoneToken(session.accessToken);
    setToken(session.accessToken);
    setStatus(null);
    setServices([]);
  };
  async function register() {
    if (registrationBusy.current || !token) return;
    const attempt = generation.current;
    const accessToken = token;
    registrationBusy.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await technicianRequest<H5OnboardingStatus>(
        PATHS.register,
        { method: "POST", body: "{}" },
        token,
      );
      if (
        mounted.current &&
        generation.current === attempt &&
        tokenRef.current === accessToken
      )
        setStatus(next);
    } catch (caught) {
      if (
        mounted.current &&
        generation.current === attempt &&
        tokenRef.current === accessToken
      ) {
        if ([401, 403].includes((caught as { status?: number }).status ?? 0))
          clear();
        setError(
          caught instanceof Error ? caught.message : "登记未完成，请重试",
        );
      }
    } finally {
      if (mounted.current && generation.current === attempt) {
        registrationBusy.current = false;
        setBusy(false);
      }
    }
  }
  async function logout() {
    const previous = tokenRef.current;
    clear();
    if (previous)
      await technicianRequest(
        "/auth/logout",
        { method: "POST", body: "{}" },
        previous,
      ).catch(() => {});
  }
  if (alternative)
    return (
      <div className="technician-onboarding">
        <button
          className="onboarding-secondary"
          onClick={() => setAlternative(null)}
        >
          返回手机号入驻
        </button>
        {alternative === "miniapp" ? (
          <TechnicianMiniappEntry />
        ) : (
          <TechnicianH5Onboarding />
        )}
      </div>
    );
  return (
    <div className="technician-onboarding phone-onboarding">
      <header className="onboarding-header">
        <span />
        <div>
          <small>中原到家 · 技师服务中心</small>
          <h1>{token ? "我的入驻申请" : "技师入驻与登录"}</h1>
        </div>
        <span>{token ? "2 / 3" : "1 / 3"}</span>
      </header>
      {!token ? (
        <TechnicianPhoneLogin
          capabilities={capabilities}
          loading={capLoading}
          error={error}
          onRetry={() => void loadCapabilities()}
          onAuthenticated={authenticated}
        />
      ) : (
        <>
          <div className="onboarding-session-bar">
            <span>{status?.phoneMasked || "本人手机号已验证"}</span>
            <button type="button" onClick={() => void logout()}>
              退出 / 更换手机号
            </button>
          </div>
          {loading ? (
            <main className="onboarding-main onboarding-loading">
              <LoaderCircle className="spinning" />
              <p>正在读取本人资料…</p>
            </main>
          ) : !status ? (
            <main className="onboarding-main">
              <p className="onboarding-error" role="alert">
                {error || "资料读取失败"}
              </p>
              <button
                className="onboarding-primary"
                onClick={() => void loadStatus()}
              >
                重新读取本人资料
              </button>
            </main>
          ) : status.stage === "PENDING_REVIEW" ? (
            <ReviewStatus
              status={status}
              phoneOnly
              onRefresh={() => loadStatus()}
            />
          ) : status.stage === "APPROVED" ? (
            <main className="onboarding-main">
              <section className="onboarding-review-hero approved">
                <CheckCircle2 />
                <h2>技师审核已通过</h2>
                <p>
                  {phoneWorkbenchAllowed(capabilities, status)
                    ? "手机号登录资格已由服务器确认，可进入本人工作台。"
                    : "资料已审核通过，网页接单工作台尚未开通，请等待平台开通；无需重新申请。"}
                </p>
              </section>
              {phoneWorkbenchAllowed(capabilities, status) && (
                <button
                  className="onboarding-primary"
                  onClick={() => onWorkbench(token)}
                >
                  进入技师工作台
                </button>
              )}
              <button
                className="onboarding-secondary"
                onClick={() => void loadStatus()}
              >
                刷新开通状态
              </button>
            </main>
          ) : status.stage === "PHONE_REQUIRED" ? (
            <main className="onboarding-main">
              <p role="alert" className="onboarding-warning">
                本人手机号验证已失效，请退出后重新验证。
              </p>
            </main>
          ) : !status.application ? (
            <main className="onboarding-main">
              <section className="onboarding-hero">
                <h2>开始填写入驻资料</h2>
                <p>
                  真实姓名、接单区域、时段、擅长项目、形象照及证件同步后台审核。
                </p>
              </section>
              {error && (
                <p className="onboarding-error" role="alert">
                  {error}
                </p>
              )}
              <button
                className="onboarding-primary"
                disabled={busy}
                onClick={() => void register()}
              >
                {busy ? "准备登记表…" : "新技师填写入驻资料"}
              </button>
            </main>
          ) : (
            <ProfileForm
              key={`${token}:${status.application.id}`}
              token={token}
              status={status}
              services={services}
              paths={PATHS}
              allowDraftSave
              onUpdated={setStatus}
              onExpired={() => {
                clear();
                setError(
                  "资料会话已失效或权限发生变化，请重新验证本人手机号。",
                );
              }}
              onReloadCatalog={() => void loadCatalog()}
              catalogError={catalogError}
            />
          )}
        </>
      )}
      {!token && (
        <details className="onboarding-alternatives">
          <summary>其他入驻方式（可选）</summary>
          <button
            type="button"
            className="onboarding-secondary"
            onClick={() => setAlternative("miniapp")}
          >
            查看小程序入驻说明
          </button>
          <a className="onboarding-secondary" href="/technician/?login=wechat">
            已有微信技师的网页辅助登录
          </a>
          {import.meta.env.VITE_TECHNICIAN_ONBOARDING_CHANNEL === "h5" && (
            <button
              type="button"
              className="onboarding-secondary"
              onClick={() => setAlternative("wechat")}
            >
              已开通的公众号网页授权
            </button>
          )}
        </details>
      )}
    </div>
  );
}
