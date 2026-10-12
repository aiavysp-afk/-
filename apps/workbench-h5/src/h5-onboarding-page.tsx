import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  Clock3,
  IdCard,
  ImagePlus,
  LoaderCircle,
  MapPin,
  MessageSquareText,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthSession } from "@zydj/contracts";
import {
  draftFromApplication,
  h5OnboardingPaths,
  isWechatBrowser,
  normalizeList,
  parseWechatCallbackTicket,
  validateOnboardingDraft,
  type H5CatalogService,
  type H5OnboardingDocumentKind,
  type H5OnboardingDraft,
  type H5OnboardingPhotoKind,
  type H5OnboardingStatus,
} from "./h5-onboarding";
import { prepareTechnicianPhoto } from "./technician-photo";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
const TOKEN_STORAGE_KEY = "zydj.technician.h5-onboarding-token";
const WORKBENCH_TOKEN_STORAGE_KEY = "zydj.technician.access-token";
const PATHS = h5OnboardingPaths();
const DAYS = [
  ["MON", "周一"], ["TUE", "周二"], ["WED", "周三"], ["THU", "周四"],
  ["FRI", "周五"], ["SAT", "周六"], ["SUN", "周日"],
] as const;
const STANDARD_SLOTS = DAYS.flatMap(([day, label]) => [
  { value: `${day}:09:00-18:00`, label: `${label} 09:00-18:00` },
  { value: `${day}:18:00-22:00`, label: `${label} 18:00-22:00` },
]);

type ApiEnvelope<T> = { data: T; message?: string };
type UploadSelection = {
  name: string;
  base64: string;
  previewUrl: string;
};

function readStoredToken() {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  token = "",
) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    credentials: "omit",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as ApiEnvelope<T> & {
    message?: string;
  };
  if (!response.ok) {
    throw Object.assign(
      new Error(body.message || `请求失败（${response.status}）`),
      { status: response.status },
    );
  }
  return body.data;
}

function OnboardingHeader({ step }: { step: number }) {
  return (
    <header className="onboarding-header">
      <button type="button" aria-label="返回" onClick={() => window.history.back()}>
        <ArrowLeft />
      </button>
      <div>
        <small>中原到家 · 技师招募</small>
        <h1>技师微信入驻</h1>
      </div>
      <span>{step}/3</span>
    </header>
  );
}

function WechatAuthorization({
  busy,
  error,
  onAuthorize,
}: {
  busy: boolean;
  error: string;
  onAuthorize: () => void;
}) {
  const inWechat =
    typeof navigator === "undefined" || isWechatBrowser(navigator.userAgent);
  return (
    <main className="onboarding-main onboarding-welcome">
      <section className="onboarding-hero">
        <div className="onboarding-hero-icon">
          <ShieldCheck />
        </div>
        <p>独立H5入驻通道</p>
        <h2>微信授权后即可填写资料</h2>
        <span>不使用配对码 · 不设置密码 · 资料直达管理后台</span>
      </section>
      <ol className="onboarding-steps">
        <li><Smartphone /><div><b>微信本人授权</b><span>用于识别本人微信账号</span></div></li>
        <li><MessageSquareText /><div><b>短信验证手机号</b><span>验证码通过后继续，无需密码</span></div></li>
        <li><CheckCircle2 /><div><b>填写资料并提交</b><span>后台审核通过后即可登录技师端</span></div></li>
      </ol>
      {!inWechat && (
        <p className="onboarding-warning" role="alert">
          请将本链接发到微信，并使用微信内置浏览器打开。
        </p>
      )}
      {error && <p className="onboarding-error" role="alert">{error}</p>}
      <button className="onboarding-primary" disabled={busy || !inWechat} onClick={onAuthorize}>
        {busy ? <LoaderCircle className="spinning" /> : <ShieldCheck />}
        {busy ? "正在连接微信…" : "微信授权并开始入驻"}
      </button>
      <p className="onboarding-consent">继续即表示同意平台为入驻审核处理您主动提交的身份与服务资料。身份证照片仅限审核使用，不在客户端公开。</p>
    </main>
  );
}

function PhoneVerification({
  token,
  onVerified,
  onExpired,
}: {
  token: string;
  onVerified: () => Promise<void>;
  onExpired: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1_000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  const handleError = (caught: unknown, fallback: string) => {
    const failure = caught as Error & { status?: number };
    if (failure.status === 401) onExpired();
    setError(failure.message || fallback);
  };

  async function sendCode() {
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      setError("请输入正确的11位手机号码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await request(PATHS.smsRequest, {
        method: "POST",
        body: JSON.stringify({ phone }),
      }, token);
      setCountdown(60);
    } catch (caught) {
      handleError(caught, "验证码发送失败");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!/^\d{6}$/.test(code)) {
      setError("请输入6位短信验证码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await request(PATHS.smsConfirm, {
        method: "POST",
        body: JSON.stringify({ phone, code }),
      }, token);
      await onVerified();
    } catch (caught) {
      handleError(caught, "手机号验证失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="onboarding-main onboarding-phone">
      <section className="onboarding-section-title">
        <span><Smartphone /></span>
        <div><small>第 2 步</small><h2>验证手机号</h2><p>仅用于入驻联系与账号安全，不需要设置密码。</p></div>
      </section>
      <label className="onboarding-field">
        手机号码
        <input inputMode="numeric" autoComplete="tel" maxLength={11} value={phone} onChange={(event) => setPhone(event.target.value.replace(/\D/g, ""))} placeholder="请输入本人手机号" />
      </label>
      <label className="onboarding-field onboarding-code-field">
        短信验证码
        <span>
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="6位验证码" />
          <button type="button" disabled={busy || countdown > 0} onClick={() => void sendCode()}>{countdown ? `${countdown}秒` : "获取验证码"}</button>
        </span>
      </label>
      {error && <p className="onboarding-error" role="alert">{error}</p>}
      <button className="onboarding-primary" disabled={busy} onClick={() => void confirm()}>{busy && <LoaderCircle className="spinning" />}验证并继续</button>
    </main>
  );
}

function ImagePicker({
  label,
  description,
  selected,
  uploaded,
  onSelect,
}: {
  label: string;
  description: string;
  selected?: UploadSelection;
  uploaded?: boolean;
  onSelect: (file: File) => Promise<void>;
}) {
  const accept = "image/jpeg,image/png";
  const choose = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void onSelect(file);
  };
  return (
    <fieldset className="onboarding-image-field">
      <legend>{label}</legend>
      <p>{description}</p>
      {(selected || uploaded) && (
        <div className="onboarding-image-preview">
          {selected ? <img src={selected.previewUrl} alt={`${label}本地预览`} /> : <CheckCircle2 />}
          <span>{selected?.name || "已安全上传"}</span>
        </div>
      )}
      <div>
        <label><Camera />拍照<input type="file" accept={accept} capture="environment" onChange={choose} /></label>
        <label><ImagePlus />相册选择<input type="file" accept={accept} onChange={choose} /></label>
      </div>
    </fieldset>
  );
}

export function OnboardingProfileFields({
  draft,
  services,
  onChange,
}: {
  draft: H5OnboardingDraft;
  services: H5CatalogService[];
  onChange: (draft: H5OnboardingDraft) => void;
}) {
  const [areaInput, setAreaInput] = useState(() => draft.serviceAreas.join("、"));
  useEffect(() => {
    setAreaInput(draft.serviceAreas.join("、"));
  }, [draft.serviceAreas.join("\u0000")]);
  const toggleSlot = (slot: string) => onChange({
    ...draft,
    availableTimeSlots: draft.availableTimeSlots.includes(slot)
      ? draft.availableTimeSlots.filter((value) => value !== slot)
      : [...draft.availableTimeSlots, slot],
  });
  const toggleService = (id: string) => onChange({
    ...draft,
    serviceIds: draft.serviceIds.includes(id)
      ? draft.serviceIds.filter((value) => value !== id)
      : [...draft.serviceIds, id],
  });
  return (
    <>
      <div className="onboarding-form-grid">
        <label className="onboarding-field">真实姓名<input autoComplete="name" maxLength={40} value={draft.realName} onChange={(event) => onChange({ ...draft, realName: event.target.value })} placeholder="须与身份证一致" /></label>
        <label className="onboarding-field">服务城市<input maxLength={32} value={draft.serviceCity} onChange={(event) => onChange({ ...draft, serviceCity: event.target.value })} placeholder="例如：郑州市" /></label>
      </div>
      <label className="onboarding-field">接单区域<input maxLength={200} value={areaInput} onChange={(event) => setAreaInput(event.target.value)} onBlur={() => onChange({ ...draft, serviceAreas: normalizeList(areaInput) })} placeholder="多个区域用逗号分隔，如：金水区、郑东新区" /><small>可以填写多个区县或商圈，后台审核后可继续调整。</small></label>
      <fieldset className="onboarding-choice-group">
        <legend><Clock3 />可接单时间段</legend>
        <div>{STANDARD_SLOTS.map((slot) => <label key={slot.value} className={draft.availableTimeSlots.includes(slot.value) ? "selected" : ""}><input type="checkbox" checked={draft.availableTimeSlots.includes(slot.value)} onChange={() => toggleSlot(slot.value)} />{slot.label}</label>)}</div>
      </fieldset>
      <label className="onboarding-field">个人简介<textarea rows={4} maxLength={1_000} value={draft.bio} onChange={(event) => onChange({ ...draft, bio: event.target.value })} placeholder="介绍从业经历、服务风格与擅长方向（至少10字）" /><small>{draft.bio.length}/1000</small></label>
      <fieldset className="onboarding-choice-group">
        <legend><CheckCircle2 />擅长项目（多选）</legend>
        <div>{services.map((service) => <label key={service.id} className={draft.serviceIds.includes(service.id) ? "selected" : ""}><input type="checkbox" checked={draft.serviceIds.includes(service.id)} onChange={() => toggleService(service.id)} />{service.name}{service.durationMinutes ? ` · ${service.durationMinutes}分钟` : ""}</label>)}</div>
        {!services.length && <p className="onboarding-inline-empty">项目读取中，请稍候…</p>}
      </fieldset>
    </>
  );
}

function ProfileForm({
  token,
  status,
  services,
  onUpdated,
  onExpired,
}: {
  token: string;
  status: H5OnboardingStatus;
  services: H5CatalogService[];
  onUpdated: (status: H5OnboardingStatus) => void;
  onExpired: () => void;
}) {
  const application = status.application;
  const [draft, setDraft] = useState(() => draftFromApplication(application));
  const [images, setImages] = useState<Partial<Record<H5OnboardingPhotoKind | H5OnboardingDocumentKind, UploadSelection>>>({});
  const imagesRef = useRef(images);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  useEffect(() => () => {
    Object.values(imagesRef.current).forEach((selection) => selection && URL.revokeObjectURL(selection.previewUrl));
  }, []);

  async function selectImage(kind: H5OnboardingPhotoKind | H5OnboardingDocumentKind, file: File) {
    setError("");
    try {
      const base64 = await prepareTechnicianPhoto(file);
      setImages((current) => {
        const previous = current[kind];
        if (previous) URL.revokeObjectURL(previous.previewUrl);
        return { ...current, [kind]: { name: file.name, base64, previewUrl: URL.createObjectURL(file) } };
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图片读取失败");
    }
  }

  async function submit() {
    const draftError = validateOnboardingDraft(draft);
    if (draftError) return setError(draftError);
    const hasAvatar = Boolean(images.AVATAR || application?.avatarUrl);
    const hasFront = Boolean(images.ID_FRONT || application?.hasIdFront);
    const hasBack = Boolean(images.ID_BACK || application?.hasIdBack);
    if (!hasAvatar) return setError("请上传一张本人形象照");
    if (!hasFront || !hasBack) return setError("请完整上传身份证正面和反面照片");
    setBusy(true);
    setError("");
    try {
      await request<H5OnboardingStatus>(PATHS.profile, {
        method: "PATCH",
        body: JSON.stringify({ ...draft, serviceAreas: normalizeList(draft.serviceAreas), availableTimeSlots: normalizeList(draft.availableTimeSlots) }),
      }, token);
      if (images.AVATAR) {
        await request<H5OnboardingStatus>(PATHS.photos, { method: "POST", body: JSON.stringify({ kind: "AVATAR", contentBase64: images.AVATAR.base64, consentConfirmed: true }) }, token);
      }
      for (const kind of ["ID_FRONT", "ID_BACK"] as const) {
        const image = images[kind];
        if (image) await request<H5OnboardingStatus>(PATHS.documents, { method: "POST", body: JSON.stringify({ kind, contentBase64: image.base64 }) }, token);
      }
      const next = await request<H5OnboardingStatus>(PATHS.submit, { method: "POST", body: "{}" }, token);
      onUpdated(next);
    } catch (caught) {
      const failure = caught as Error & { status?: number };
      if (failure.status === 401) onExpired();
      setError(failure.message || "资料提交失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="onboarding-main onboarding-profile-form">
      <section className="onboarding-section-title"><span><MapPin /></span><div><small>第 3 步</small><h2>{status.stage === "REJECTED" ? "修改入驻资料" : "填写入驻资料"}</h2><p>信息会同步至PC管理后台技师列表，提交后进入人工审核。</p></div></section>
      {status.stage === "REJECTED" && application?.rejectionReason && <p className="onboarding-rejected"><b>资料已退回</b>{application.rejectionReason}</p>}
      <OnboardingProfileFields draft={draft} services={services} onChange={setDraft} />
      <section className="onboarding-upload-block">
        <h3>照片与身份证明</h3><p>支持直接拍照或从相册选择 JPG/PNG 图片。</p>
        <ImagePicker label="本人形象照" description="用于后台审核；审核发布后展示在技师卡片与详情页。" selected={images.AVATAR} uploaded={Boolean(application?.avatarUrl)} onSelect={(file) => selectImage("AVATAR", file)} />
        <ImagePicker label="身份证正面" description="仅限实名认证与资质审核，不对客户公开。" selected={images.ID_FRONT} uploaded={application?.hasIdFront} onSelect={(file) => selectImage("ID_FRONT", file)} />
        <ImagePicker label="身份证反面" description="仅限实名认证与资质审核，不对客户公开。" selected={images.ID_BACK} uploaded={application?.hasIdBack} onSelect={(file) => selectImage("ID_BACK", file)} />
      </section>
      {error && <p className="onboarding-error" role="alert">{error}</p>}
      <button className="onboarding-primary" disabled={busy || !services.length} onClick={() => void submit()}>{busy && <LoaderCircle className="spinning" />}{busy ? "正在安全提交…" : "提交后台审核"}</button>
      <p className="onboarding-consent">身份证件仅用于入驻资格审核并按权限隔离保存。审核前不会对客户公开您的资料。</p>
    </main>
  );
}

function ReviewStatus({ status, onRefresh }: { status: H5OnboardingStatus; onRefresh: () => Promise<void> }) {
  const application = status.application;
  return (
    <main className="onboarding-main onboarding-review-status">
      <section className="onboarding-review-hero"><CheckCircle2 /><small>资料已成功提交</small><h2>后台审核中</h2><p>无需重复提交。再次微信扫码进入本页面，也会直接显示当前审核进度。</p></section>
      <ol className="review-timeline"><li className="complete"><i /><div><b>微信及手机号验证</b><span>{status.phoneMasked || "已完成"}</span></div></li><li className="complete"><i /><div><b>入驻资料已同步</b><span>{application?.updatedAt ? `${new Date(application.updatedAt).toLocaleString("zh-CN")} 已写入PC管理后台` : "已写入PC管理后台"}</span></div></li><li className="active"><i /><div><b>等待管理员审核</b><span>审核结果将在技师端同步展示</span></div></li><li><i /><div><b>审核通过</b><span>同一微信再次进入即可登录技师端</span></div></li></ol>
      <section className="onboarding-summary"><h3>本次申请</h3><dl><div><dt>真实姓名</dt><dd>{application?.realName || "已提交"}</dd></div><div><dt>服务城市</dt><dd>{application?.serviceCity || "已提交"}</dd></div><div><dt>接单区域</dt><dd>{application?.serviceAreas.join("、") || "已提交"}</dd></div><div><dt>身份证件</dt><dd>{application?.hasIdFront && application.hasIdBack ? "正反面已上传" : "后台校验中"}</dd></div></dl></section>
      <button className="onboarding-secondary" onClick={() => void onRefresh()}>刷新审核进度</button>
      <p className="onboarding-consent">审核人员如需补充资料，会在此页面显示退回原因。请勿向他人提供短信验证码。</p>
    </main>
  );
}

function ApprovedStatus({ token }: { token: string }) {
  const enterWorkbench = () => {
    window.sessionStorage.setItem(WORKBENCH_TOKEN_STORAGE_KEY, token);
    window.location.assign("/technician/");
  };
  return <main className="onboarding-main onboarding-review-status"><section className="onboarding-review-hero approved"><CheckCircle2 /><small>审核已完成</small><h2>技师身份已通过</h2><p>当前微信账号已取得技师权限。进入工作台后，请按安全提示完成首次验证。</p></section><button className="onboarding-primary onboarding-link" onClick={enterWorkbench}>进入技师工作台</button></main>;
}

export function TechnicianH5Onboarding() {
  const [token, setToken] = useState(readStoredToken);
  const [status, setStatus] = useState<H5OnboardingStatus | null>(null);
  const [services, setServices] = useState<H5CatalogService[]>([]);
  const [loading, setLoading] = useState(Boolean(token));
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState("");

  const storeToken = useCallback((value: string) => {
    setToken(value);
    if (value) window.sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
    else window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  }, []);

  const expire = useCallback(() => {
    storeToken("");
    setStatus(null);
    setError("授权会话已过期，请重新微信授权");
  }, [storeToken]);

  const loadStatus = useCallback(async (accessToken = token) => {
    if (!accessToken) return;
    setLoading(true);
    setError("");
    try {
      let current = await request<H5OnboardingStatus>(PATHS.status, {}, accessToken);
      if (!current.application && current.stage === "PROFILE_REQUIRED") {
        current = await request<H5OnboardingStatus>(PATHS.register, { method: "POST", body: "{}" }, accessToken);
      }
      setStatus(current);
    } catch (caught) {
      const failure = caught as Error & { status?: number };
      if (failure.status === 401) expire();
      else setError(failure.message || "入驻状态读取失败");
    } finally {
      setLoading(false);
    }
  }, [expire, token]);

  useEffect(() => {
    request<H5CatalogService[]>(PATHS.catalog).then(setServices).catch(() => setServices([]));
  }, []);

  useEffect(() => {
    const ticket = parseWechatCallbackTicket(window.location.hash);
    if (!ticket) {
      if (token) void loadStatus(token);
      return;
    }
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setAuthorizing(true);
    setError("");
    request<AuthSession>(PATHS.wechatExchange, { method: "POST", body: JSON.stringify({ ticket }) })
      .then((session) => {
        storeToken(session.accessToken);
        return loadStatus(session.accessToken);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "微信授权失败"))
      .finally(() => setAuthorizing(false));
  }, []); // OAuth ticket must be exchanged once only.

  const step = status?.stage === "PHONE_REQUIRED" ? 2 : status ? 3 : 1;
  const authorize = () => {
    setAuthorizing(true);
    setError("");
    const start = new URL(`${API_BASE_URL}${PATHS.wechatStart}`, window.location.origin);
    window.location.assign(start.toString());
  };

  const verified = async () => {
    let next = await request<H5OnboardingStatus>(PATHS.register, { method: "POST", body: "{}" }, token);
    if (!next.application) next = await request<H5OnboardingStatus>(PATHS.status, {}, token);
    setStatus(next);
  };

  const content = useMemo(() => {
    if (!token || (!status && !loading)) return <WechatAuthorization busy={authorizing} error={error} onAuthorize={authorize} />;
    if (loading || !status) return <main className="onboarding-main onboarding-loading"><LoaderCircle className="spinning" /><p>正在读取入驻资料…</p>{error && <p className="onboarding-error">{error}</p>}</main>;
    if (status.stage === "PHONE_REQUIRED") return <PhoneVerification token={token} onVerified={verified} onExpired={expire} />;
    if (status.stage === "PENDING_REVIEW") return <ReviewStatus status={status} onRefresh={() => loadStatus()} />;
    if (status.stage === "APPROVED") return <ApprovedStatus token={token} />;
    return <ProfileForm key={status.application?.updatedAt || status.stage} token={token} status={status} services={services} onUpdated={setStatus} onExpired={expire} />;
  }, [authorizing, error, expire, loading, services, status, token, loadStatus]);

  return <div className="technician-onboarding"><OnboardingHeader step={step} />{content}</div>;
}
