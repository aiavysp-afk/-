import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardList,
  Headphones,
  MessageSquareWarning,
  Newspaper,
  RefreshCw,
  Save,
  ShieldCheck,
  Smartphone,
  TicketPercent,
  UserRoundX,
  WalletCards,
} from "lucide-react";
import {
  customerCenterPaths,
  splitCustomerCenterLines,
  validateCustomerCenterConfig,
  type CustomerCenterConfig,
  type CustomerCenterConfigDraft,
  type CustomerCenterSummary,
} from "./customer-center";
import type { AuthUser } from "@zydj/contracts";
import { canViewOrganizationWallet } from "./stored-value-ledger";
import { createLatestRequest, useBackgroundRefresh } from "./synchronization";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";

async function request<T>(
  path: string,
  token: string,
  body?: CustomerCenterConfigDraft,
) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: body ? "PATCH" : "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = (await response.json().catch(() => ({}))) as {
    data?: T;
    message?: string;
  };
  if (!response.ok || !result.data) {
    throw new Error(result.message || `请求失败（${response.status}）`);
  }
  return result.data;
}

function draftFrom(config: CustomerCenterConfig): CustomerCenterConfigDraft {
  return {
    levelLabel: config.levelLabel,
    customerServicePhone: config.customerServicePhone,
    cityNewsTitle: config.cityNewsTitle,
    cityNewsContent: config.cityNewsContent,
    appBannerTitle: config.appBannerTitle,
    appBannerSubtitle: config.appBannerSubtitle,
    appDownloadUrl: config.appDownloadUrl,
    safeguardItems: config.safeguardItems,
  };
}

function formatMoney(fen: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
  }).format(fen / 100);
}

function CustomerCenterGate({ login }: { login: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="catalog-workspace">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">CUSTOMER EXPERIENCE</span>
          <h2>客户中心</h2>
          <p>登录后维护客户端个人中心文案并查看脱敏运营摘要。</p>
        </div>
        {import.meta.env.DEV && (
          <button
            className="primary-action"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              void login()
                .catch((caught) =>
                  setError(
                    caught instanceof Error ? caught.message : "登录失败",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "登录中…" : "登录本地管理员"}
          </button>
        )}
      </div>
      <div className="catalog-gate">
        <ShieldCheck size={20} />
        <div>
          <strong>客户中心数据需要授权身份</strong>
          <p>未登录不会展示订单、优惠券、余额或客户申请摘要。</p>
        </div>
      </div>
      {error && <div className="catalog-error">{error}</div>}
    </section>
  );
}

export function CustomerCenterWorkspace({
  token,
  organizationId,
  login,
  user,
}: {
  token: string;
  organizationId: string;
  login: () => Promise<void>;
  user: AuthUser | null;
}) {
  const [config, setConfig] = useState<CustomerCenterConfig | null>(null);
  const [draft, setDraft] = useState<CustomerCenterConfigDraft | null>(null);
  const [summary, setSummary] = useState<CustomerCenterSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requests = useMemo(createLatestRequest, []);
  const summaryRequests = useMemo(createLatestRequest, []);
  const paths = useMemo(
    () => customerCenterPaths(organizationId),
    [organizationId],
  );

  const load = useCallback(async () => {
    if (!token || !organizationId) return;
    const isCurrent = requests.begin();
    const summaryIsCurrent = summaryRequests.begin();
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const [nextConfig, nextSummary] = await Promise.all([
        request<CustomerCenterConfig>(paths.config, token),
        request<CustomerCenterSummary>(paths.summary, token),
      ]);
      if (!isCurrent()) return;
      setConfig(nextConfig);
      setDraft(draftFrom(nextConfig));
      if (summaryIsCurrent()) setSummary(nextSummary);
    } catch (caught) {
      if (!isCurrent()) return;
      setConfig(null);
      setDraft(null);
      setSummary(null);
      setError(
        caught instanceof Error ? caught.message : "客户中心数据读取失败",
      );
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [
    organizationId,
    paths.config,
    paths.summary,
    token,
    requests,
    summaryRequests,
  ]);

  useEffect(() => void load(), [load]);
  useEffect(
    () => () => {
      requests.invalidate();
      summaryRequests.invalidate();
    },
    [requests, summaryRequests],
  );
  const refreshSummary = useCallback(async () => {
    if (!token || !organizationId) return;
    const isCurrent = summaryRequests.begin();
    try {
      const value = await request<CustomerCenterSummary>(paths.summary, token);
      if (isCurrent()) setSummary(value);
    } catch (caught) {
      if (!isCurrent()) return;
      setSummary(null);
      setError(
        caught instanceof Error ? caught.message : "客户中心统计读取失败",
      );
    }
  }, [organizationId, paths.summary, token, summaryRequests]);
  useBackgroundRefresh(
    () => void refreshSummary(),
    Boolean(token && organizationId && !loading),
  );

  if (!token || !organizationId) return <CustomerCenterGate login={login} />;

  async function save() {
    if (!draft || saving) return;
    const normalized: CustomerCenterConfigDraft = {
      levelLabel: draft.levelLabel.trim(),
      customerServicePhone: draft.customerServicePhone?.trim() || null,
      cityNewsTitle: draft.cityNewsTitle.trim(),
      cityNewsContent: draft.cityNewsContent.trim(),
      appBannerTitle: draft.appBannerTitle.trim(),
      appBannerSubtitle: draft.appBannerSubtitle.trim(),
      appDownloadUrl: draft.appDownloadUrl?.trim() || null,
      safeguardItems: draft.safeguardItems
        .map((item) => item.trim())
        .filter(Boolean),
    };
    const validationErrors = validateCustomerCenterConfig(normalized);
    if (validationErrors.length) {
      setError(validationErrors.join("；"));
      setMessage("");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const value = await request<CustomerCenterConfig>(
        paths.config,
        token,
        normalized,
      );
      setConfig(value);
      setDraft(draftFrom(value));
      setMessage("客户中心配置已保存，客户端将读取同一份配置。");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "客户中心配置保存失败",
      );
    } finally {
      setSaving(false);
    }
  }

  const orderMetrics = summary
    ? [
        ["待付款", summary.orders.pendingPayment],
        ["进行中", summary.orders.inProgress],
        ["待评价", summary.orders.pendingReview],
        ["已取消", summary.orders.cancelled],
      ]
    : [];

  return (
    <section className="catalog-workspace customer-center-workspace">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">CUSTOMER EXPERIENCE</span>
          <h2>客户中心配置与监控</h2>
          <p>客户端文案共用组织配置；摘要不展示手机号、地址等客户隐私。</p>
        </div>
        <div className="catalog-actions">
          <button
            className="ghost-action"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={15} className={loading ? "spinning" : ""} />
            刷新
          </button>
          <button
            className="primary-action"
            disabled={!draft || saving}
            onClick={() => void save()}
          >
            <Save size={15} />
            {saving ? "保存中…" : "保存并同步"}
          </button>
        </div>
      </div>
      {error && <div className="catalog-error">{error}</div>}
      {message && <div className="profile-admin-success">{message}</div>}
      {loading && !summary && (
        <div className="catalog-empty">正在读取客户中心配置…</div>
      )}

      {summary && (
        <>
          <div className="customer-center-summary-head">
            <div>
              <ClipboardList size={20} />
              <span>客户订单状态</span>
            </div>
            <small>
              更新于 {new Date(summary.generatedAt).toLocaleString("zh-CN")}
            </small>
          </div>
          <div className="customer-center-order-grid">
            {orderMetrics.map(([label, value]) => (
              <article key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>当前客户中心订单数</small>
              </article>
            ))}
          </div>
          <div className="customer-center-monitor-grid">
            <article>
              <TicketPercent size={20} />
              <div>
                <span>优惠券</span>
                <strong>{summary.coupons.available}</strong>
              </div>
              <p>
                可用 {summary.coupons.available} · 已使用 {summary.coupons.used}{" "}
                · 已过期 {summary.coupons.expired}
              </p>
            </article>
            {canViewOrganizationWallet(user, organizationId) && (
              <article>
                <WalletCards size={20} />
                <div>
                  <span>储值账户</span>
                  <strong>{summary.wallet.customerCount}</strong>
                </div>
                <p>
                  余额合计 {formatMoney(summary.wallet.totalBalanceFen)} · 流水{" "}
                  {summary.wallet.transactionCount}
                </p>
              </article>
            )}
            <article className={summary.feedback.open ? "attention" : ""}>
              <MessageSquareWarning size={20} />
              <div>
                <span>反馈与投诉</span>
                <strong>{summary.feedback.open}</strong>
              </div>
              <p>
                待处理 {summary.feedback.open} · 累计 {summary.feedback.total}
              </p>
            </article>
            <article
              className={
                summary.accountDeletionRequests.pending ? "attention" : ""
              }
            >
              <UserRoundX size={20} />
              <div>
                <span>注销申请</span>
                <strong>{summary.accountDeletionRequests.pending}</strong>
              </div>
              <p>
                待复核 {summary.accountDeletionRequests.pending} · 累计{" "}
                {summary.accountDeletionRequests.total}
              </p>
            </article>
          </div>
        </>
      )}

      {draft && (
        <div className="customer-center-config-layout">
          <article className="panel customer-center-config-card">
            <div className="customer-center-card-heading">
              <div>
                <span className="eyebrow">CLIENT CONTENT</span>
                <h3>个人中心文案</h3>
              </div>
              <small>
                {config?.updatedAt
                  ? `最近保存 ${new Date(config.updatedAt).toLocaleString("zh-CN")}`
                  : "尚未保存组织专属配置"}
              </small>
            </div>
            <div className="customer-center-form">
              <label>
                用户等级文案
                <input
                  maxLength={30}
                  value={draft.levelLabel}
                  onChange={(event) =>
                    setDraft({ ...draft, levelLabel: event.target.value })
                  }
                />
              </label>
              <label>
                客服电话（可留空）
                <input
                  maxLength={30}
                  inputMode="tel"
                  placeholder="未配置"
                  value={draft.customerServicePhone ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      customerServicePhone: event.target.value || null,
                    })
                  }
                />
                <small>仅展示后台真实配置；留空时客户端显示“未配置”。</small>
              </label>
              <label>
                城市快讯标题
                <input
                  maxLength={40}
                  value={draft.cityNewsTitle}
                  onChange={(event) =>
                    setDraft({ ...draft, cityNewsTitle: event.target.value })
                  }
                />
              </label>
              <label className="customer-center-wide">
                城市快讯内容
                <textarea
                  rows={3}
                  maxLength={300}
                  value={draft.cityNewsContent}
                  onChange={(event) =>
                    setDraft({ ...draft, cityNewsContent: event.target.value })
                  }
                />
              </label>
              <label>
                APP 横幅标题
                <input
                  maxLength={50}
                  value={draft.appBannerTitle}
                  onChange={(event) =>
                    setDraft({ ...draft, appBannerTitle: event.target.value })
                  }
                />
              </label>
              <label>
                APP 横幅说明
                <input
                  maxLength={80}
                  value={draft.appBannerSubtitle}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      appBannerSubtitle: event.target.value,
                    })
                  }
                />
              </label>
              <label className="customer-center-wide">
                官方 APP 下载地址（可留空）
                <input
                  inputMode="url"
                  placeholder="仅填写已核验的中原到家 HTTPS 官方地址"
                  value={draft.appDownloadUrl ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      appDownloadUrl: event.target.value || null,
                    })
                  }
                />
                <small>留空时客户端展示“APP 筹备中”，不会跳转外部网站。</small>
              </label>
              <label className="customer-center-wide">
                服务保障文案（每行一条）
                <textarea
                  rows={5}
                  maxLength={500}
                  value={draft.safeguardItems.join("\n")}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      safeguardItems: splitCustomerCenterLines(
                        event.target.value,
                      ),
                    })
                  }
                />
              </label>
            </div>
          </article>

          <aside className="customer-center-preview">
            <div className="customer-center-preview-title">
              <Smartphone size={18} />
              客户端预览
            </div>
            <div className="customer-center-mobile-card">
              <div className="customer-center-mobile-profile">
                <span>客</span>
                <div>
                  <strong>微信用户</strong>
                  <small>{draft.levelLabel || "用户等级"}</small>
                </div>
                <Headphones size={20} />
              </div>
              <div className="customer-center-mobile-panels">
                <span>优惠券</span>
                <span>储值卡余额 ****</span>
              </div>
              <div className="customer-center-mobile-news">
                <Newspaper size={18} />
                <div>
                  <strong>{draft.cityNewsTitle || "城市快讯"}</strong>
                  <small>{draft.cityNewsContent || "暂无快讯"}</small>
                </div>
              </div>
              <div className="customer-center-mobile-banner">
                <strong>{draft.appBannerTitle || "中原到家官方服务"}</strong>
                <small>{draft.appBannerSubtitle || "官方客户端信息"}</small>
                <em>{draft.appDownloadUrl ? "查看官方 APP" : "APP 筹备中"}</em>
              </div>
              <div className="customer-center-mobile-safeguards">
                {draft.safeguardItems.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
