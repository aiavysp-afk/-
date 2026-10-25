import { useEffect, useRef, useState } from "react";
import {
  HomeCampaignSaveSchema,
  type AdminHomeCampaign,
} from "@zydj/contracts";
import { authenticatedFetch } from "./authenticated-fetch";
import { prepareTechnicianPhoto } from "./technician-photo";
import "./home-campaign.css";

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
const localTime = (iso: string | null) =>
  iso
    ? new Date(Date.parse(iso) - new Date(iso).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : "";

export function HomeCampaignEditor({
  token,
  organizationId,
}: {
  token: string;
  organizationId: string;
}) {
  const [draft, setDraft] = useState<AdminHomeCampaign | null>(null);
  const [image, setImage] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const path = `${API}/admin/organizations/${encodeURIComponent(organizationId)}/customer-center/home-campaign`;
  useEffect(() => {
    const ticket = ++generation.current;
    setDraft(null);
    setImage(undefined);
    setBusy(false);
    setError("");
    setMessage("");
    void authenticatedFetch(token, path, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "活动读取失败");
        if (generation.current === ticket) setDraft(result.data);
      })
      .catch((e) => {
        if (generation.current === ticket) setError(e.message);
      });
    return () => {
      generation.current++;
    };
  }, [path, token, reload]);
  function change<K extends keyof AdminHomeCampaign>(
    key: K,
    value: AdminHomeCampaign[K],
  ) {
    setDraft((v) => (v ? { ...v, [key]: value } : v));
    setMessage("");
  }
  async function upload(file?: File) {
    if (!file || busy) return;
    const ticket = generation.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const base64 = await prepareTechnicianPhoto(file);
      if (ticket === generation.current) setImage(base64);
    } catch (e) {
      if (ticket === generation.current)
        setError(e instanceof Error ? e.message : "图片读取失败");
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  }
  async function save() {
    if (!draft || busy) return;
    const {
      organizationId: _,
      version,
      imagePath: __,
      imageDataUrl: ___,
      ...content
    } = draft;
    const parsed = HomeCampaignSaveSchema.safeParse({
      ...content,
      expectedVersion: version,
      ...(image === undefined ? {} : { imageBase64: image }),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "请检查活动内容");
      return;
    }
    const ticket = generation.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await authenticatedFetch(token, path, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(parsed.data),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "活动保存失败");
      if (ticket !== generation.current) return;
      setDraft(result.data);
      setImage(undefined);
      setMessage(
        result.data.enabled
          ? "活动已保存，客户端按生效时间和展示频次同步。"
          : "活动已关闭，客户端下次进入首页不再弹出。",
      );
    } catch (e) {
      if (ticket === generation.current)
        setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  }
  const previewImage =
    image === undefined
      ? draft?.imageDataUrl
      : image
        ? `data:image/jpeg;base64,${image}`
        : null;
  return (
    <section className="home-campaign-editor">
      <header>
        <div>
          <span className="eyebrow">HOME CAMPAIGN</span>
          <h3>首页活动弹窗</h3>
          <p>可关闭的动态活动卡片；保存后无需重新上传小程序。</p>
        </div>
        <button
          className="ghost-action"
          disabled={busy}
          onClick={() => setReload((v) => v + 1)}
        >
          重新读取
        </button>
      </header>
      {error && (
        <div className="catalog-error" role="alert">
          {error}
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {draft && (
        <div className="home-campaign-layout">
          <fieldset disabled={busy}>
            <label className="campaign-toggle">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => change("enabled", e.target.checked)}
              />
              启用首页活动
            </label>
            <label>
              活动标题
              <input
                maxLength={30}
                value={draft.title}
                onChange={(e) => change("title", e.target.value)}
              />
            </label>
            <label>
              说明及使用规则
              <textarea
                maxLength={160}
                value={draft.body}
                onChange={(e) => change("body", e.target.value)}
              />
            </label>
            <label>
              活动图片（选填，JPG / PNG）
              <input
                type="file"
                accept="image/jpeg,image/png"
                onChange={(e) => {
                  void upload(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            {previewImage && (
              <button type="button" onClick={() => setImage(null)}>
                移除图片，使用品牌文字卡片
              </button>
            )}
            <label>
              按钮文字
              <input
                maxLength={12}
                value={draft.buttonText}
                onChange={(e) => change("buttonText", e.target.value)}
              />
            </label>
            <label>
              点击后前往
              <select
                value={draft.target}
                onChange={(e) =>
                  change(
                    "target",
                    e.target.value as AdminHomeCampaign["target"],
                  )
                }
              >
                <option value="COUPONS">优惠券</option>
                <option value="SERVICES">服务项目</option>
                <option value="WALLET">余额充值</option>
                <option value="NONE">仅关闭弹窗</option>
              </select>
            </label>
            <label>
              展示频次
              <select
                value={draft.frequency}
                onChange={(e) =>
                  change(
                    "frequency",
                    e.target.value as AdminHomeCampaign["frequency"],
                  )
                }
              >
                <option value="DAILY">每台设备每天一次</option>
                <option value="ONCE">每台设备每个版本一次</option>
              </select>
            </label>
            <label>
              开始时间（北京时间，本机时区）
              <input
                type="datetime-local"
                value={localTime(draft.startsAt)}
                onChange={(e) =>
                  change(
                    "startsAt",
                    e.target.value
                      ? new Date(e.target.value).toISOString()
                      : null,
                  )
                }
              />
            </label>
            <label>
              结束时间（留空持续展示）
              <input
                type="datetime-local"
                value={localTime(draft.endsAt)}
                onChange={(e) =>
                  change(
                    "endsAt",
                    e.target.value
                      ? new Date(e.target.value).toISOString()
                      : null,
                  )
                }
              />
            </label>
            <button className="primary-action" onClick={() => void save()}>
              {busy ? "保存中…" : "保存活动配置"}
            </button>
            <small>
              修改后保存会生成新版本；运营账号可维护，发布验证沿用账户安全规则。
            </small>
          </fieldset>
          <div className="home-campaign-preview">
            <div className="campaign-preview-card">
              <span
                className="campaign-preview-close"
                aria-label="关闭按钮示意"
              >
                ×
              </span>
              {previewImage ? (
                <img src={previewImage} alt="活动预览" />
              ) : (
                <div className="campaign-preview-art">
                  <span>中原到家</span>
                  <strong>专享好礼</strong>
                  <small>把放松带回家</small>
                </div>
              )}
              <h3>{draft.title}</h3>
              <p>{draft.body}</p>
              <span className="campaign-preview-button">
                {draft.buttonText}
              </span>
              <small>预览 · 顾客可随时关闭</small>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
