import { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  Bell,
  CalendarDays,
  ChevronDown,
  CircleDollarSign,
  ClipboardList,
  HeartHandshake,
  LayoutDashboard,
  LogOut,
  MapPinned,
  MessageCircleWarning,
  PanelsTopLeft,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  AdminServiceItem,
  AuthSession,
  DispatchBoard,
  OperationsDashboard,
  ServiceItem,
} from "@zydj/contracts";
import { formatMoney } from "@zydj/contracts";
import "./styles.css";
import { RefundWorkspace } from "./refunds";
import { SecurityWorkspace } from "./security";
import { SafetyWorkspace } from "./safety";
import { CustomerCenterWorkspace } from "./customer-center-workspace";
import {
  AuditWorkspace,
  SchedulingWorkspace,
  ServiceAreaWorkspace,
  SystemWorkspace,
  TechniciansWorkspace,
} from "./admin-resources";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
const TOKEN_STORAGE_KEY = "zydj.admin.access-token";

type Section =
  | "dashboard"
  | "dispatch"
  | "technicians"
  | "catalog"
  | "scheduling"
  | "refunds"
  | "safety"
  | "area"
  | "audit"
  | "security"
  | "customerCenter"
  | "settings";
type CatalogRow = AdminServiceItem | ServiceItem;

const nav: Array<{
  icon: LucideIcon;
  label: string;
  section?: Section;
}> = [
  { icon: LayoutDashboard, label: "经营概览", section: "dashboard" },
  { icon: ClipboardList, label: "订单调度", section: "dispatch" },
  { icon: UsersRound, label: "技师管理", section: "technicians" },
  { icon: Sparkles, label: "服务项目", section: "catalog" },
  { icon: PanelsTopLeft, label: "客户中心", section: "customerCenter" },
  { icon: CalendarDays, label: "排班中心", section: "scheduling" },
  { icon: CircleDollarSign, label: "退款复核", section: "refunds" },
  { icon: MessageCircleWarning, label: "安全值班", section: "safety" },
  { icon: MapPinned, label: "服务区域", section: "area" },
  { icon: ShieldCheck, label: "权限审计", section: "audit" },
  { icon: ShieldCheck, label: "账户安全", section: "security" },
];

const statusLabels: Record<string, string> = {
  PENDING_PAYMENT: "待支付",
  PAID: "已支付",
  DISPATCHING: "待调度",
  ASSIGNED: "已指派",
  EN_ROUTE: "已出发",
  ARRIVED: "已到达",
  IN_SERVICE: "服务中",
  AWAITING_CONFIRMATION: "待确认",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  REFUNDING: "退款中",
  REFUNDED: "已退款",
};

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  if (!response.ok) {
    throw Object.assign(
      new Error(body.message ?? `请求失败（${response.status}）`),
      { status: response.status },
    );
  }
  return body as T;
}

function Dashboard({
  token,
  organizationId,
  login,
  query,
}: {
  token: string;
  organizationId: string;
  login: () => Promise<void>;
  query: string;
}) {
  const [dashboard, setDashboard] = useState<OperationsDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token || !organizationId) return;
    setLoading(true);
    setError("");
    try {
      const response = await apiRequest<{ data: OperationsDashboard }>(
        `/admin/organizations/${organizationId}/dashboard`,
        {},
        token,
      );
      setDashboard(response.data);
    } catch (caught) {
      setDashboard(null);
      setError(caught instanceof Error ? caught.message : "经营概览加载失败");
    } finally {
      setLoading(false);
    }
  }, [organizationId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!token || !organizationId) {
    return (
      <section className="catalog-workspace">
        <div className="catalog-heading">
          <div>
            <span className="eyebrow">OPERATIONS</span>
            <h2>经营概览</h2>
            <p>登录后读取所属组织的真实订单与资金汇总。</p>
          </div>
          {import.meta.env.DEV && (
            <button className="primary-action" onClick={() => void login()}>
              登录本地运营账号
            </button>
          )}
        </div>
        <div className="catalog-gate">
          <ShieldCheck size={20} />
          <div>
            <strong>经营数据需要授权身份</strong>
            <p>页面不会在未登录时展示虚构订单、收入或技师信息。</p>
          </div>
        </div>
      </section>
    );
  }

  const metrics = dashboard
    ? [
        {
          label: "今日预约",
          value: String(dashboard.metrics.todayOrders),
          note: `${dashboard.day} · 郑州时间`,
          tone: "green",
        },
        {
          label: "履约中",
          value: String(dashboard.metrics.activeOrders),
          note: "已支付至待确认",
          tone: "sand",
        },
        {
          label: "今日支付成功",
          value: formatMoney(dashboard.metrics.paidTodayFen),
          note: "含后续进入退款流程的原支付",
          tone: "rose",
        },
        {
          label: "待处理事项",
          value: String(dashboard.metrics.attentionRequired),
          note: "超时支付、异常退款与安全事件",
          tone: "ink",
        },
      ]
    : [];
  const dashboardOrders =
    dashboard?.recentOrders.filter((order) => {
      const needle = query.trim().toLowerCase();
      return (
        !needle ||
        [
          order.orderNo,
          order.customerName,
          order.serviceName,
          order.therapistName ?? "",
          statusLabels[order.status] ?? order.status,
        ].some((value) => value.toLowerCase().includes(needle))
      );
    }) ?? [];

  return (
    <>
      <section className="notice">
        <span>开发环境</span>
        <p>
          下方数据来自本地数据库；微信支付、短信、地图与正式安全值班仍未接入。
        </p>
        <button onClick={() => void load()} disabled={loading}>
          {loading ? "读取中…" : "刷新数据"}
        </button>
      </section>
      {error && <div className="catalog-error">{error}</div>}
      <section className="metrics">
        {metrics.map((metric) => (
          <article className={metric.tone} key={metric.label}>
            <div>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              <small>{metric.note}</small>
            </div>
            <div className="metric-orbit" />
          </article>
        ))}
      </section>
      {dashboard && (
        <section className="content-grid">
          <article className="panel orders dashboard-orders">
            <div className="panel-head">
              <div>
                <h2>今日创建的订单</h2>
                <p>最多显示最近 10 条，不包含服务地址</p>
              </div>
              <small>
                更新于{" "}
                {new Date(dashboard.generatedAt).toLocaleTimeString("zh-CN")}
              </small>
            </div>
            <div className="table">
              <div className="tr th">
                <span>订单 / 客户</span>
                <span>服务项目</span>
                <span>预约时间</span>
                <span>技师</span>
                <span>状态</span>
              </div>
              {dashboardOrders.map((order) => (
                <div className="tr" key={order.id}>
                  <span>
                    <b>{order.orderNo}</b>
                    <small>{order.customerName}</small>
                  </span>
                  <span>
                    {order.serviceName}
                    <small>{formatMoney(order.payableFen)}</small>
                  </span>
                  <span>
                    {new Date(order.appointmentStart).toLocaleTimeString(
                      "zh-CN",
                      {
                        hour: "2-digit",
                        minute: "2-digit",
                      },
                    )}
                  </span>
                  <span>{order.therapistName ?? "待匹配"}</span>
                  <span>
                    <em>{statusLabels[order.status] ?? order.status}</em>
                  </span>
                </div>
              ))}
              {dashboardOrders.length === 0 && (
                <div className="catalog-empty">
                  {query.trim() ? "没有匹配的订单" : "今日暂无新订单"}
                </div>
              )}
            </div>
          </article>
        </section>
      )}
    </>
  );
}

function DispatchWorkspace({
  token,
  organizationId,
  login,
  query,
}: {
  token: string;
  organizationId: string;
  login: () => Promise<void>;
  query: string;
}) {
  const [board, setBoard] = useState<DispatchBoard | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!token || !organizationId) return;
    setLoading(true);
    setError("");
    try {
      const response = await apiRequest<{ data: DispatchBoard }>(
        `/admin/organizations/${organizationId}/dispatch`,
        {},
        token,
      );
      setBoard(response.data);
      setSelection((current) => {
        const next = { ...current };
        for (const order of response.data.orders) {
          next[order.id] =
            current[order.id] ??
            order.therapist?.id ??
            order.eligibleTherapists[0]?.id ??
            "";
        }
        return next;
      });
    } catch (caught) {
      setBoard(null);
      setError(caught instanceof Error ? caught.message : "调度看板加载失败");
    } finally {
      setLoading(false);
    }
  }, [organizationId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function assign(orderId: string) {
    const therapistId = selection[orderId];
    if (!therapistId) return;
    setSavingId(orderId);
    setError("");
    setMessage("");
    try {
      await apiRequest(
        `/admin/organizations/${organizationId}/dispatch/orders/${orderId}/assign`,
        { method: "POST", body: JSON.stringify({ therapistId }) },
        token,
      );
      setMessage("技师指派成功，订单已进入履约队列。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "技师指派失败");
    } finally {
      setSavingId("");
    }
  }

  if (!token || !organizationId) {
    return (
      <section className="catalog-workspace">
        <div className="catalog-heading">
          <div>
            <span className="eyebrow">ORDER DISPATCH</span>
            <h2>订单调度</h2>
            <p>登录后读取待调度订单，并按有效排班指派技师。</p>
          </div>
          {import.meta.env.DEV && (
            <button className="primary-action" onClick={() => void login()}>
              登录本地调度账号
            </button>
          )}
        </div>
        <div className="catalog-gate">
          <ShieldCheck size={20} />
          <div>
            <strong>调度操作需要授权身份</strong>
            <p>未登录时不会展示订单、客户或技师数据。</p>
          </div>
        </div>
      </section>
    );
  }

  const visibleOrders =
    board?.orders.filter((order) => {
      const needle = query.trim().toLowerCase();
      return (
        !needle ||
        [
          order.orderNo,
          order.customerName,
          order.serviceName,
          order.therapist?.displayName ?? "",
        ].some((value) => value.toLowerCase().includes(needle))
      );
    }) ?? [];

  return (
    <section className="catalog-workspace dispatch-workspace">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">ORDER DISPATCH</span>
          <h2>订单调度</h2>
          <p>仅列出已支付、调度中与已指派订单；不展示地址和电话。</p>
        </div>
        <button
          className="ghost-action"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={15} className={loading ? "spinning" : ""} />
          {loading ? "读取中…" : "刷新"}
        </button>
      </div>
      <div className="catalog-gate dispatch-rule">
        <ShieldCheck size={20} />
        <div>
          <strong>排班与冲突校验已启用</strong>
          <p>只能指派覆盖完整预约时段且没有其他预约冲突的在岗技师。</p>
        </div>
      </div>
      {message && <div className="dispatch-message">{message}</div>}
      {error && <div className="catalog-error">{error}</div>}
      <div className="dispatch-table panel">
        <div className="dispatch-row dispatch-head">
          <span>订单 / 客户</span>
          <span>服务与预约</span>
          <span>状态</span>
          <span>技师指派</span>
        </div>
        {visibleOrders.map((order) => {
          const isAssigned = order.status === "ASSIGNED";
          return (
            <div className="dispatch-row" key={order.id}>
              <span>
                <b>{order.orderNo}</b>
                <small>{order.customerName}</small>
              </span>
              <span>
                <b>{order.serviceName}</b>
                <small>
                  {new Date(order.appointmentStart).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  · {order.durationMinutes} 分钟 ·{" "}
                  {formatMoney(order.payableFen)}
                </small>
              </span>
              <span>
                <em className={isAssigned ? "status-on" : "status-waiting"}>
                  {statusLabels[order.status] ?? order.status}
                </em>
              </span>
              <span className="dispatch-action">
                <select
                  aria-label={`为订单 ${order.orderNo} 选择技师`}
                  value={selection[order.id] ?? ""}
                  onChange={(event) =>
                    setSelection((current) => ({
                      ...current,
                      [order.id]: event.target.value,
                    }))
                  }
                  disabled={isAssigned || savingId === order.id}
                >
                  <option value="">暂无可用技师</option>
                  {order.eligibleTherapists.map((therapist) => (
                    <option value={therapist.id} key={therapist.id}>
                      {therapist.displayName}
                    </option>
                  ))}
                </select>
                <button
                  className="primary-action compact"
                  disabled={
                    isAssigned || !selection[order.id] || savingId === order.id
                  }
                  onClick={() => void assign(order.id)}
                >
                  {isAssigned
                    ? `已指派 ${order.therapist?.displayName ?? "技师"}`
                    : savingId === order.id
                      ? "指派中…"
                      : "确认指派"}
                </button>
              </span>
            </div>
          );
        })}
        {!loading && board && visibleOrders.length === 0 && (
          <div className="catalog-empty">
            {query.trim() ? "没有匹配的调度订单" : "当前没有待调度订单"}
          </div>
        )}
        {loading && !board && (
          <div className="catalog-empty">正在读取调度订单…</div>
        )}
      </div>
      {board && (
        <small className="dispatch-updated">
          最近读取：
          {new Date(board.generatedAt).toLocaleString("zh-CN", {
            timeZone: board.timeZone,
          })}
        </small>
      )}
    </section>
  );
}

function CatalogWorkspace({
  token,
  onDevelopmentLogin,
  query,
}: {
  token: string;
  onDevelopmentLogin: () => Promise<void>;
  query: string;
}) {
  const [services, setServices] = useState<CatalogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = token
        ? await apiRequest<{ data: AdminServiceItem[] }>(
            "/admin/catalog/services",
            {},
            token,
          )
        : await apiRequest<{ data: ServiceItem[] }>("/catalog/services");
      setServices(response.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "服务目录加载失败");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function togglePublished(service: AdminServiceItem) {
    setSavingId(service.id);
    setError("");
    try {
      const action = service.published ? "unpublish" : "publish";
      await apiRequest(
        `/admin/catalog/services/${service.id}/${action}`,
        { method: "POST" },
        token,
      );
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "状态更新失败");
    } finally {
      setSavingId("");
    }
  }
  const visibleServices = services.filter((service) => {
    const needle = query.trim().toLowerCase();
    return (
      !needle ||
      [service.name, service.subtitle, service.category].some((value) =>
        value.toLowerCase().includes(needle),
      )
    );
  });

  return (
    <section className="catalog-workspace">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">SERVICE CATALOG</span>
          <h2>服务项目</h2>
          <p>
            {token
              ? "从 PostgreSQL 读取，可安全控制上架状态。"
              : "当前为公开目录只读视图。"}
          </p>
        </div>
        <div className="catalog-actions">
          {import.meta.env.DEV && !token && (
            <button
              className="primary-action"
              onClick={() => void onDevelopmentLogin()}
            >
              登录本地运营账号
            </button>
          )}
          <button
            className="ghost-action"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? "spinning" : ""} />
            刷新
          </button>
        </div>
      </div>

      {!token && (
        <div className="catalog-gate">
          <ShieldCheck size={20} />
          <div>
            <strong>管理操作需要运营权限</strong>
            <p>
              正式环境需接入管理员微信登录和多因素验证；开发环境可使用明确标记的本地账号。
            </p>
          </div>
        </div>
      )}
      {error && <div className="catalog-error">{error}</div>}

      <div className="catalog-table panel">
        <div className="catalog-row catalog-table-head">
          <span>项目</span>
          <span>类别</span>
          <span>时长</span>
          <span>价格</span>
          <span>状态</span>
          <span>操作</span>
        </div>
        {visibleServices.map((service) => {
          const adminService = "published" in service ? service : undefined;
          return (
            <div className="catalog-row" key={service.id}>
              <span className="service-cell">
                <b>{service.name}</b>
                <small>{service.subtitle}</small>
              </span>
              <span>
                {service.category === "FOOT_CARE"
                  ? "足部舒缓"
                  : service.category === "SPA_RELAXATION"
                    ? "SPA 放松"
                    : "按摩舒缓"}
              </span>
              <span>{service.durationMinutes} 分钟</span>
              <span className="catalog-price">
                ¥{(service.priceFen / 100).toFixed(2)}
              </span>
              <span>
                <em
                  className={
                    adminService?.published === false
                      ? "status-off"
                      : "status-on"
                  }
                >
                  {adminService?.published === false ? "已下架" : "已上架"}
                </em>
              </span>
              <span>
                {adminService ? (
                  <button
                    className={
                      adminService.published
                        ? "danger-action"
                        : "primary-action compact"
                    }
                    onClick={() => void togglePublished(adminService)}
                    disabled={savingId === service.id}
                  >
                    {savingId === service.id
                      ? "处理中…"
                      : adminService.published
                        ? "下架"
                        : "上架"}
                  </button>
                ) : (
                  <small>只读</small>
                )}
              </span>
            </div>
          );
        })}
        {!loading && visibleServices.length === 0 && (
          <div className="catalog-empty">
            {query.trim() ? "没有匹配的服务项目" : "暂无服务项目"}
          </div>
        )}
        {loading && <div className="catalog-empty">正在读取服务目录…</div>}
      </div>
    </section>
  );
}

function App() {
  const [section, setSection] = useState<Section>("dashboard");
  const [query, setQuery] = useState("");
  const [token, setToken] = useState(
    () => sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "",
  );
  const [displayName, setDisplayName] = useState("未登录");
  const [organizationId, setOrganizationId] = useState("");
  const currentToken = useRef(token);
  currentToken.current = token;

  useEffect(() => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    if (!token) return;
    let current = true;
    void apiRequest<{
      data: {
        displayName: string;
        memberships: Array<{ organizationId: string }>;
      };
    }>("/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (current) {
          setDisplayName(r.data.displayName);
          setOrganizationId(r.data.memberships[0]?.organizationId ?? "");
        }
      })
      .catch((error: { status?: number }) => {
        if (!current || currentToken.current !== token) return;
        if (error.status === 401) {
          sessionStorage.removeItem(TOKEN_STORAGE_KEY);
          currentToken.current = "";
          setToken("");
          setDisplayName("未登录");
          setOrganizationId("");
        } else setDisplayName("会话待重新验证");
      });
    return () => {
      current = false;
    };
  }, [token]);

  async function logout() {
    const logoutToken = token;
    try {
      await apiRequest("/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 401) throw error;
    }
    if (currentToken.current !== logoutToken) return;
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    currentToken.current = "";
    setToken("");
    setDisplayName("未登录");
    setOrganizationId("");
  }

  async function developmentLogin(code = "local-safety-admin") {
    const response = await apiRequest<{ data: AuthSession }>(
      "/auth/wechat-miniapp",
      {
        method: "POST",
        body: JSON.stringify({ code }),
      },
    );
    sessionStorage.setItem(TOKEN_STORAGE_KEY, response.data.accessToken);
    currentToken.current = response.data.accessToken;
    setToken(response.data.accessToken);
    setDisplayName(response.data.user.displayName);
    setOrganizationId(response.data.user.memberships[0]?.organizationId ?? "");
  }

  function acceptBrowserSession(session: AuthSession) {
    if (currentToken.current) {
      void apiRequest(
        "/auth/logout",
        { method: "POST", body: "{}" },
        session.accessToken,
      ).catch(() => {});
      return;
    }
    sessionStorage.setItem(TOKEN_STORAGE_KEY, session.accessToken);
    currentToken.current = session.accessToken;
    setToken(session.accessToken);
    setDisplayName(session.user.displayName);
    setOrganizationId(session.user.memberships[0]?.organizationId ?? "");
  }

  const canSearch = (
    ["dashboard", "dispatch", "technicians", "catalog", "audit"] as Section[]
  ).includes(section);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">中</div>
          <div>
            <strong>中原到家</strong>
            <span>生活养护服务</span>
          </div>
        </div>
        <nav>
          {nav.map(({ icon: Icon, label, section: target }) => (
            <button
              className={target === section ? "active" : ""}
              disabled={!target}
              key={label}
              onClick={() => {
                if (!target) return;
                setSection(target);
                setQuery("");
              }}
            >
              <Icon size={19} />
              <span>{label}</span>
              {target === section && <i />}
            </button>
          ))}
        </nav>
        <button
          className="sidebar-card"
          onClick={() => {
            setSection("settings");
            setQuery("");
          }}
        >
          <HeartHandshake size={24} />
          <strong>服务合规中心</strong>
          <p>协议、隐私与安全门禁</p>
          <span>查看上线清单 →</span>
        </button>
        <button
          className="settings"
          onClick={() => {
            setSection("settings");
            setQuery("");
          }}
        >
          <Settings size={19} />
          系统设置
        </button>
      </aside>
      <main>
        <header>
          <div>
            <p>
              {new Date().toLocaleDateString("zh-CN", {
                timeZone: "Asia/Shanghai",
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </p>
            <h1>
              {section === "dashboard"
                ? "运营中心"
                : section === "dispatch"
                  ? "订单调度"
                  : section === "technicians"
                    ? "技师管理"
                    : section === "customerCenter"
                      ? "客户中心配置与监控"
                      : section === "scheduling"
                        ? "排班中心"
                        : section === "security"
                          ? "账户安全"
                          : section === "safety"
                            ? "安全值班与升级"
                            : section === "refunds"
                              ? "退款申请与复核"
                              : section === "area"
                                ? "服务区域"
                                : section === "audit"
                                  ? "权限审计"
                                  : section === "settings"
                                    ? "系统设置与上线门禁"
                                    : "服务目录管理"}
            </h1>
          </div>
          <div className="header-actions">
            {canSearch && (
              <label>
                <Search size={18} />
                <input
                  placeholder="搜索当前页面"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            )}
            <button
              className="bell"
              aria-label="打开安全值班"
              onClick={() => {
                setSection("safety");
                setQuery("");
              }}
            >
              <Bell size={20} />
              <span />
            </button>
            <div className="profile">
              <div>管</div>
              <span>
                <strong>{displayName}</strong>
                <small>{token ? "已登录 · 总部" : "只读视图"}</small>
              </span>
              <ChevronDown size={16} />
            </div>
            {token && (
              <button
                className="logout-button"
                aria-label="退出当前后台账号"
                onClick={() => void logout()}
              >
                <LogOut size={17} />
                退出
              </button>
            )}
          </div>
        </header>
        {section === "dashboard" ? (
          <Dashboard
            token={token}
            organizationId={organizationId}
            login={() => developmentLogin()}
            query={query}
          />
        ) : section === "dispatch" ? (
          <DispatchWorkspace
            token={token}
            organizationId={organizationId}
            login={() => developmentLogin("local-scheduling-dispatcher")}
            query={query}
          />
        ) : section === "technicians" ? (
          <TechniciansWorkspace
            token={token}
            organizationId={organizationId}
            login={() => developmentLogin("local-safety-admin")}
            query={query}
          />
        ) : section === "customerCenter" ? (
          <CustomerCenterWorkspace
            token={token}
            organizationId={organizationId}
            login={() => developmentLogin("local-safety-admin")}
          />
        ) : section === "scheduling" ? (
          <SchedulingWorkspace
            token={token}
            organizationId={organizationId}
            login={() => developmentLogin("local-safety-admin")}
          />
        ) : section === "security" ? (
          <SecurityWorkspace
            token={token}
            onLogout={logout}
            onSession={acceptBrowserSession}
          />
        ) : section === "refunds" ? (
          <RefundWorkspace token={token} login={developmentLogin} />
        ) : section === "safety" ? (
          <SafetyWorkspace token={token} login={developmentLogin} />
        ) : section === "area" ? (
          <ServiceAreaWorkspace
            token={token}
            organizationId={organizationId}
            login={() => developmentLogin("local-safety-admin")}
          />
        ) : section === "audit" ? (
          <AuditWorkspace
            token={token}
            organizationId={organizationId}
            login={() => developmentLogin("local-safety-admin")}
            query={query}
          />
        ) : section === "settings" ? (
          <SystemWorkspace
            token={token}
            organizationId={organizationId}
            login={() => developmentLogin("local-safety-admin")}
          />
        ) : (
          <CatalogWorkspace
            token={token}
            onDevelopmentLogin={() => developmentLogin()}
            query={query}
          />
        )}
      </main>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<App />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
