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
  MapPinned,
  MessageCircleWarning,
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
  ServiceItem,
} from "@zydj/contracts";
import "./styles.css";
import { RefundWorkspace } from "./refunds";
import { SecurityWorkspace } from "./security";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
const TOKEN_STORAGE_KEY = "zydj.admin.access-token";

type Section = "dashboard" | "catalog" | "refunds" | "security";
type CatalogRow = AdminServiceItem | ServiceItem;

const nav: Array<{
  icon: LucideIcon;
  label: string;
  section?: Section;
}> = [
  { icon: LayoutDashboard, label: "经营概览", section: "dashboard" },
  { icon: ClipboardList, label: "订单调度" },
  { icon: UsersRound, label: "技师管理" },
  { icon: Sparkles, label: "服务项目", section: "catalog" },
  { icon: CalendarDays, label: "排班中心" },
  { icon: CircleDollarSign, label: "退款复核", section: "refunds" },
  { icon: MessageCircleWarning, label: "安全值班" },
  { icon: MapPinned, label: "服务区域" },
  { icon: ShieldCheck, label: "权限审计" },
  { icon: ShieldCheck, label: "账户安全", section: "security" },
];

const metrics = [
  { label: "今日预约", value: "28", note: "较昨日 +12%", tone: "green" },
  { label: "进行中", value: "06", note: "均在计划时段", tone: "sand" },
  {
    label: "今日成交",
    value: "¥ 4,860",
    note: "演示口径 · 未接支付",
    tone: "rose",
  },
  { label: "待处理事项", value: "03", note: "1 条需要优先处理", tone: "ink" },
];

const orders = [
  [
    "ZY202610030026",
    "林女士",
    "全身释压 SPA",
    "14:00–15:30",
    "安然",
    "服务中",
    "live",
  ],
  [
    "ZY202610030025",
    "周先生",
    "肩颈舒缓",
    "14:30–15:30",
    "若溪",
    "已出发",
    "route",
  ],
  [
    "ZY202610030024",
    "陈女士",
    "足部舒缓",
    "15:00–16:00",
    "待匹配",
    "待调度",
    "wait",
  ],
  [
    "ZY202610030023",
    "王女士",
    "肩颈舒缓",
    "13:00–14:00",
    "静宜",
    "已完成",
    "done",
  ],
];

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
    throw new Error(body.message ?? `请求失败（${response.status}）`);
  }
  return body as T;
}

function Dashboard() {
  return (
    <>
      <section className="notice">
        <span>开发环境</span>
        <p>
          当前为演示数据，微信支付、短信、地图与安全热线尚未接入，不可用于真实经营。
        </p>
        <button>查看接入门禁</button>
      </section>
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
      <section className="content-grid">
        <article className="panel orders">
          <div className="panel-head">
            <div>
              <h2>今日订单</h2>
              <p>履约状态与调度进度</p>
            </div>
            <button>查看全部订单</button>
          </div>
          <div className="table">
            <div className="tr th">
              <span>订单 / 客户</span>
              <span>服务项目</span>
              <span>预约时间</span>
              <span>技师</span>
              <span>状态</span>
            </div>
            {orders.map((order) => (
              <div className="tr" key={order[0]}>
                <span>
                  <b>{order[0]}</b>
                  <small>{order[1]}</small>
                </span>
                <span>{order[2]}</span>
                <span>{order[3]}</span>
                <span>{order[4]}</span>
                <span>
                  <em className={order[6]}>{order[5]}</em>
                </span>
              </div>
            ))}
          </div>
        </article>
        <article className="panel pulse">
          <div className="panel-head">
            <div>
              <h2>履约脉搏</h2>
              <p>当前时段服务分布</p>
            </div>
            <span className="live-dot">实时演示</span>
          </div>
          <div className="donut">
            <div>
              <strong>18</strong>
              <span>活跃订单</span>
            </div>
          </div>
          <div className="legend">
            <span>
              <i className="g" />
              服务中 <b>6</b>
            </span>
            <span>
              <i className="y" />
              在途中 <b>4</b>
            </span>
            <span>
              <i className="p" />
              待开始 <b>5</b>
            </span>
            <span>
              <i className="n" />
              待调度 <b>3</b>
            </span>
          </div>
        </article>
      </section>
      <section className="bottom-grid">
        <article className="panel">
          <div className="panel-head">
            <div>
              <h2>今日排班</h2>
              <p>8 位技师在线 · 演示数据</p>
            </div>
            <button>排班中心</button>
          </div>
          <div className="therapists">
            {["安然", "若溪", "静宜", "知夏", "南乔"].map((name, index) => (
              <div key={name}>
                <span className={`avatar a${index}`}>{name[0]}</span>
                <b>{name}</b>
                <small>
                  {index < 3 ? "服务中" : index === 3 ? "在途中" : "可接单"}
                </small>
              </div>
            ))}
          </div>
        </article>
        <article className="panel alert-panel">
          <div className="panel-head">
            <div>
              <h2>待处理</h2>
              <p>按风险与时效排序</p>
            </div>
          </div>
          <div className="task">
            <span className="danger">急</span>
            <div>
              <b>订单待人工调度</b>
              <small>预约时间 15:00 · 已等待 6 分钟</small>
            </div>
            <button>处理</button>
          </div>
          <div className="task">
            <span>审</span>
            <div>
              <b>2 位技师资料待审核</b>
              <small>身份材料仅限授权角色查看</small>
            </div>
            <button>查看</button>
          </div>
        </article>
      </section>
    </>
  );
}

function CatalogWorkspace({
  token,
  onDevelopmentLogin,
}: {
  token: string;
  onDevelopmentLogin: () => Promise<void>;
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
        {services.map((service) => {
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
        {!loading && services.length === 0 && (
          <div className="catalog-empty">暂无服务项目</div>
        )}
        {loading && <div className="catalog-empty">正在读取服务目录…</div>}
      </div>
    </section>
  );
}

function App() {
  const [section, setSection] = useState<Section>("dashboard");
  const [token, setToken] = useState(
    () => localStorage.getItem(TOKEN_STORAGE_KEY) ?? "",
  );
  const [displayName, setDisplayName] = useState("未登录");
  const currentToken = useRef(token);
  currentToken.current = token;

  useEffect(() => {
    if (!token) return;
    let current = true;
    void apiRequest<{ data: { displayName: string } }>("/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (current) setDisplayName(r.data.displayName);
      })
      .catch(() => {
        if (current) setDisplayName("会话待重新验证");
      });
    return () => {
      current = false;
    };
  }, [token]);

  async function logout() {
    const logoutToken = token;
    await apiRequest("/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    if (currentToken.current !== logoutToken) return;
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken("");
    setDisplayName("未登录");
  }

  async function developmentLogin(code = "local-catalog-operator") {
    const response = await apiRequest<{ data: AuthSession }>(
      "/auth/wechat-miniapp",
      {
        method: "POST",
        body: JSON.stringify({ code }),
      },
    );
    localStorage.setItem(TOKEN_STORAGE_KEY, response.data.accessToken);
    setToken(response.data.accessToken);
    setDisplayName(response.data.user.displayName);
  }

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
              onClick={() => target && setSection(target)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {target === section && <i />}
            </button>
          ))}
        </nav>
        <div className="sidebar-card">
          <HeartHandshake size={24} />
          <strong>服务合规中心</strong>
          <p>协议、隐私与安全门禁</p>
          <a>查看上线清单 →</a>
        </div>
        <button className="settings">
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
                : section === "security"
                  ? "账户安全"
                  : section === "refunds"
                    ? "退款申请与复核"
                    : "服务目录管理"}
            </h1>
          </div>
          <div className="header-actions">
            <label>
              <Search size={18} />
              <input placeholder="搜索订单、技师或客户" />
            </label>
            <button className="bell">
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
          </div>
        </header>
        {section === "dashboard" ? (
          <Dashboard />
        ) : section === "security" ? (
          <SecurityWorkspace token={token} onLogout={logout} />
        ) : section === "refunds" ? (
          <RefundWorkspace token={token} login={developmentLogin} />
        ) : (
          <CatalogWorkspace
            token={token}
            onDevelopmentLogin={() => developmentLogin()}
          />
        )}
      </main>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<App />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
