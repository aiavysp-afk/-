import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactDOM from "react-dom/client";
import type {
  AuthSession,
  TechnicianEarnings,
  TechnicianOrderAction,
  TechnicianRoute,
  TechnicianWorkbench,
  TechnicianWorkbenchOrder,
  TechnicianPhotoUploadResult,
} from "@zydj/contracts";
import {
  Bell,
  CalendarDays,
  ChevronRight,
  Clock3,
  Home,
  MapPin,
  Navigation,
  RefreshCw,
  ShieldAlert,
  UserRound,
  WalletCards,
} from "lucide-react";
import "./styles.css";
import { dialEmergencyDuty, emergencyPhoneFromConfig } from "./support";
import {
  buildAmapNavigationUrl,
  formatRoute,
  getBrowserGcj02Location,
} from "./map";
import {
  profileDraftFrom,
  profileStatusLabels,
  splitProfileList,
  technicianWorkbenchProfilePaths,
  type TechnicianProfile,
  type TechnicianProfileDraft,
} from "./technician-profile";
import { loadTechnicianPhotoPreview, prepareTechnicianPhoto } from "./technician-photo";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
const TOKEN_STORAGE_KEY = "zydj.technician.access-token";
const TECHNICIAN_PROFILE_PATHS = technicianWorkbenchProfilePaths();
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
const actionByStatus: Partial<
  Record<
    TechnicianWorkbenchOrder["status"],
    {
      action: TechnicianOrderAction["action"];
      label: string;
      confirmation?: string;
    }
  >
> = {
  PAID: { action: "ACCEPT", label: "立即接单" },
  DISPATCHING: { action: "ACCEPT", label: "立即接单" },
  ASSIGNED: { action: "DEPART", label: "确认出发" },
  EN_ROUTE: { action: "ARRIVE", label: "确认已到达" },
  ARRIVED: {
    action: "START_SERVICE",
    label: "开始服务",
    confirmation: "确认已与客户当面核验并开始本次服务？",
  },
  IN_SERVICE: {
    action: "FINISH_SERVICE",
    label: "提交服务完成",
    confirmation: "确认服务已经结束，并提交给客户进行完成确认？",
  },
};

type WorkbenchView = "today" | "orders" | "shifts" | "profile";
type StaffLoginChallenge = {
  pairCode: string;
  browserSecret: string;
  confirmationCode: string;
  expiresAt: string;
  pollIntervalSeconds: number;
  audience: string;
};

const viewHeadings: Record<WorkbenchView, { eyebrow: string; title: string }> =
  {
    today: { eyebrow: "今日工作台", title: "愿你今天服务顺利" },
    orders: { eyebrow: "服务任务", title: "我的订单" },
    shifts: { eyebrow: "郑州时间", title: "本周排班" },
    profile: { eyebrow: "技师中心", title: "我的" },
  };

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  token = "",
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

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDay(value: string) {
  return new Date(value).toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
}

function formatMoney(value: number) {
  return `¥${(value / 100).toFixed(2)}`;
}

function App() {
  const [token, setToken] = useState(
    () => sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "",
  );
  const [workbench, setWorkbench] = useState<TechnicianWorkbench | null>(null);
  const [earnings, setEarnings] = useState<TechnicianEarnings | null>(null);
  const [emergencyPhone, setEmergencyPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingOrderId, setSavingOrderId] = useState("");
  const [routeByOrder, setRouteByOrder] = useState<
    Record<string, TechnicianRoute>
  >({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [view, setView] = useState<WorkbenchView>("today");
  const [loginChallenge, setLoginChallenge] =
    useState<StaffLoginChallenge | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [incomingOrders, setIncomingOrders] = useState<
    TechnicianWorkbenchOrder[]
  >([]);
  const dismissedIncoming = useRef(new Set<string>());
  const loadingRequest = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    fetch(`${API_BASE_URL}/config/public`, {
      signal: abort.signal,
      redirect: "error",
    })
      .then((response) => {
        if (!response.ok) throw Error("Configuration unavailable");
        return response.json();
      })
      .then((value) => setEmergencyPhone(emergencyPhoneFromConfig(value)))
      .catch(() => {
        if (!abort.signal.aborted) setEmergencyPhone("");
      });
    return () => abort.abort();
  }, []);

  const load = useCallback(
    async (silent = false) => {
      if (!token || loadingRequest.current) return;
      loadingRequest.current = true;
      if (!silent) {
        setLoading(true);
        setError("");
      }
      try {
        const [workbenchResponse, earningsResponse] = await Promise.all([
          apiRequest<{ data: TechnicianWorkbench }>(
            "/technician/workbench",
            {},
            token,
          ),
          apiRequest<{ data: TechnicianEarnings }>(
            "/technician/workbench/earnings",
            {},
            token,
          ),
        ]);
        setWorkbench(workbenchResponse.data);
        setEarnings(earningsResponse.data);
        const incoming = workbenchResponse.data.orders.filter((order) =>
          ["PAID", "DISPATCHING"].includes(order.status),
        );
        setIncomingOrders((current) => {
          const known = new Set(current.map((order) => order.id));
          return [
            ...current.filter((order) =>
              incoming.some((candidate) => candidate.id === order.id),
            ),
            ...incoming.filter(
              (order) =>
                !known.has(order.id) &&
                !dismissedIncoming.current.has(order.id),
            ),
          ];
        });
      } catch (caught) {
        const failure = caught as Error & { status?: number };
        setWorkbench(null);
        setEarnings(null);
        if (!silent) setError(failure.message || "工作台加载失败");
        if (failure.status === 401) {
          sessionStorage.removeItem(TOKEN_STORAGE_KEY);
          setToken("");
        }
      } finally {
        loadingRequest.current = false;
        if (!silent) setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!token) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [load, token]);

  useEffect(() => {
    if (!loginChallenge || token) return;
    let stopped = false;
    const poll = async () => {
      if (Date.parse(loginChallenge.expiresAt) <= Date.now()) {
        setLoginChallenge(null);
        setError("微信登录配对已过期，请重新发起");
        return;
      }
      try {
        const response = await apiRequest<{ data: { status: string } }>(
          "/auth/browser-login/poll",
          {
            method: "POST",
            body: JSON.stringify({
              pairCode: loginChallenge.pairCode,
              browserSecret: loginChallenge.browserSecret,
            }),
          },
        );
        if (response.data.status !== "APPROVED" || stopped) return;
        const claimed = await apiRequest<{ data: AuthSession }>(
          "/auth/browser-login/claim",
          {
            method: "POST",
            body: JSON.stringify({
              pairCode: loginChallenge.pairCode,
              browserSecret: loginChallenge.browserSecret,
            }),
          },
        );
        if (
          !claimed.data.user.memberships.some(
            (membership) => membership.role === "THERAPIST",
          )
        ) {
          throw new Error("当前微信账号尚未在管理后台绑定为技师");
        }
        sessionStorage.setItem(TOKEN_STORAGE_KEY, claimed.data.accessToken);
        setToken(claimed.data.accessToken);
        setLoginChallenge(null);
        setMessage("微信登录成功，正在同步后台订单。");
      } catch (caught) {
        const failure = caught as Error & { status?: number };
        if (failure.status !== 429 && !stopped) {
          setError(failure.message || "微信登录状态读取失败");
        }
      }
    };
    void poll();
    const timer = window.setInterval(
      () => void poll(),
      Math.max(2_100, loginChallenge.pollIntervalSeconds * 1_000 + 100),
    );
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [loginChallenge, token]);

  function refresh() {
    setMessage("");
    void load();
  }

  async function startWechatLogin() {
    if (loginBusy) return;
    setLoginBusy(true);
    setError("");
    try {
      const response = await apiRequest<{ data: StaffLoginChallenge }>(
        "/auth/browser-login/create",
        { method: "POST", body: "{}" },
      );
      setLoginChallenge(response.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "微信登录发起失败");
    } finally {
      setLoginBusy(false);
    }
  }

  async function developmentLogin() {
    setLoading(true);
    setError("");
    try {
      const response = await apiRequest<{ data: AuthSession }>(
        "/auth/wechat-miniapp",
        {
          method: "POST",
          body: JSON.stringify({ code: "local-therapist-anran" }),
        },
      );
      sessionStorage.setItem(TOKEN_STORAGE_KEY, response.data.accessToken);
      setToken(response.data.accessToken);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "本地登录失败");
      setLoading(false);
    }
  }

  async function logout() {
    try {
      await apiRequest("/auth/logout", { method: "POST", body: "{}" }, token);
    } catch {
      // Removing an expired local session is still safe.
    }
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken("");
    setWorkbench(null);
    setEarnings(null);
    setError("");
    setMessage("");
    setView("today");
    setIncomingOrders([]);
    dismissedIncoming.current.clear();
  }

  async function advanceOrder(order: TechnicianWorkbenchOrder) {
    const operation = actionByStatus[order.status];
    if (!operation) return false;
    if (operation.confirmation && !window.confirm(operation.confirmation)) {
      return false;
    }
    setSavingOrderId(order.id);
    setError("");
    setMessage("");
    try {
      await apiRequest(
        `/technician/workbench/orders/${order.id}/actions`,
        {
          method: "POST",
          body: JSON.stringify({ action: operation.action }),
        },
        token,
      );
      setMessage(`${operation.label}成功，履约状态已更新。`);
      await load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "履约状态更新失败");
      return false;
    } finally {
      setSavingOrderId("");
    }
  }

  async function acceptIncomingOrder(order: TechnicianWorkbenchOrder) {
    const accepted = await advanceOrder(order);
    if (!accepted) return;
    dismissedIncoming.current.add(order.id);
    setIncomingOrders((current) =>
      current.filter((candidate) => candidate.id !== order.id),
    );
  }

  function dismissIncomingOrder(order: TechnicianWorkbenchOrder) {
    dismissedIncoming.current.add(order.id);
    setIncomingOrders((current) =>
      current.filter((candidate) => candidate.id !== order.id),
    );
  }

  async function reportAndRoute(order: TechnicianWorkbenchOrder) {
    if (!order.destination) {
      setError("该订单缺少 GCJ-02 上门坐标，请联系调度处理。");
      return;
    }
    setSavingOrderId(order.id);
    setError("");
    setMessage("");
    try {
      const location = await getBrowserGcj02Location();
      await apiRequest(
        "/technician/workbench/location",
        { method: "POST", body: JSON.stringify(location) },
        token,
      );
      const response = await apiRequest<{ data: TechnicianRoute }>(
        `/technician/workbench/orders/${order.id}/route`,
        {},
        token,
      );
      setRouteByOrder((current) => ({ ...current, [order.id]: response.data }));
      setMessage("当前位置已上报，高德驾车距离和预计时长已更新。");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "位置上报或路线计算失败",
      );
    } finally {
      setSavingOrderId("");
    }
  }

  function openAmapNavigation(order: TechnicianWorkbenchOrder) {
    if (!order.destination) {
      setError("该订单缺少可导航的上门坐标。");
      return;
    }
    window.location.assign(buildAmapNavigationUrl(order.destination));
  }

  const nextOrder = useMemo(
    () =>
      workbench?.orders.find(
        (order) =>
          !["COMPLETED", "CANCELLED", "REFUNDED"].includes(order.status) &&
          new Date(order.appointmentEnd).getTime() >= Date.now(),
      ) ?? null,
    [workbench],
  );

  return (
    <div className="phone-app">
      <header>
        <div>
          <p>
            {workbench
              ? view === "today"
                ? `你好，${workbench.displayName}`
                : viewHeadings[view].eyebrow
              : "中原到家技师端"}
          </p>
          <h1>{workbench ? viewHeadings[view].title : "技师工作台"}</h1>
        </div>
        <button aria-label="刷新后台订单" onClick={refresh} disabled={!token}>
          <Bell size={19} />
        </button>
      </header>
      <main>
        {!token && (
          <section className="workbench-gate">
            <ShieldAlert size={24} />
            <h2>需要技师身份</h2>
            <p>使用本人微信登录；账号须已在管理后台绑定为有效技师。</p>
            {!loginChallenge && (
              <button
                onClick={() => void startWechatLogin()}
                disabled={loginBusy}
              >
                {loginBusy ? "正在生成登录码…" : "微信登录技师端"}
              </button>
            )}
            {loginChallenge && (
              <div className="pairing-card">
                <strong>请在“中原到家”小程序确认</strong>
                <span>我的 → 工作人员登录确认</span>
                <label>配对码</label>
                <code>{loginChallenge.pairCode}</code>
                <label>六位核对数字</label>
                <b>{loginChallenge.confirmationCode}</b>
                <small>确认后本页会自动登录，无需刷新。</small>
                <button
                  className="secondary"
                  onClick={() => setLoginChallenge(null)}
                >
                  取消本次登录
                </button>
              </div>
            )}
            {import.meta.env.DEV && (
              <button
                onClick={() => void developmentLogin()}
                disabled={loading}
              >
                {loading ? "登录中…" : "登录本地技师账号"}
              </button>
            )}
          </section>
        )}

        {token && !workbench && (
          <section className="workbench-gate">
            <RefreshCw className={loading ? "spinning" : ""} />
            <h2>{loading ? "正在读取工作台" : "工作台暂不可用"}</h2>
            <p>{error || "请检查本地 API 后重试。"}</p>
            <button onClick={refresh} disabled={loading}>
              重新读取
            </button>
            <button className="secondary" onClick={() => void logout()}>
              退出登录
            </button>
          </section>
        )}

        {workbench && (
          <>
            {error && <div className="error-banner">{error}</div>}
            {message && <div className="success-banner">{message}</div>}
            {view === "today" && (
              <TodayView
                workbench={workbench}
                earnings={earnings}
                nextOrder={nextOrder}
                loading={loading}
                savingOrderId={savingOrderId}
                onRefresh={refresh}
                onAdvance={advanceOrder}
                routeByOrder={routeByOrder}
                onReportAndRoute={reportAndRoute}
                onOpenNavigation={openAmapNavigation}
                onNavigate={setView}
              />
            )}
            {view === "orders" && (
              <OrdersView
                workbench={workbench}
                savingOrderId={savingOrderId}
                onAdvance={advanceOrder}
                routeByOrder={routeByOrder}
                onReportAndRoute={reportAndRoute}
                onOpenNavigation={openAmapNavigation}
              />
            )}
            {view === "shifts" && <ShiftsView workbench={workbench} />}
            {view === "profile" && (
              <ProfileView
                workbench={workbench}
                earnings={earnings}
                token={token}
                onLogout={logout}
              />
            )}
          </>
        )}
      </main>
      {incomingOrders[0] && (
        <div className="incoming-backdrop" role="dialog" aria-modal="true">
          <section className="incoming-order">
            <Bell size={26} />
            <span className="incoming-kicker">新预约已付款</span>
            <h2>请及时确认接单</h2>
            <p>{incomingOrders[0].serviceName}</p>
            <dl>
              <div>
                <dt>预约日期</dt>
                <dd>{formatDay(incomingOrders[0].appointmentStart)}</dd>
              </div>
              <div>
                <dt>上门时间</dt>
                <dd>{formatTime(incomingOrders[0].appointmentStart)}</dd>
              </div>
              <div>
                <dt>订单编号</dt>
                <dd>{incomingOrders[0].orderNo}</dd>
              </div>
            </dl>
            <button
              onClick={() => void acceptIncomingOrder(incomingOrders[0]!)}
              disabled={savingOrderId === incomingOrders[0].id}
            >
              {savingOrderId === incomingOrders[0].id
                ? "正在接单…"
                : "立即接单"}
            </button>
            <button
              className="secondary"
              onClick={() => dismissIncomingOrder(incomingOrders[0]!)}
              disabled={savingOrderId === incomingOrders[0].id}
            >
              稍后在订单页处理
            </button>
          </section>
        </div>
      )}
      <button
        className="sos"
        aria-label="拨打商家紧急值班电话"
        onClick={() =>
          dialEmergencyDuty(
            emergencyPhone,
            (target) => window.location.assign(target),
            (message) => window.alert(message),
          )
        }
      >
        <ShieldAlert size={17} />
        <span>紧急值班</span>
      </button>
      <nav>
        <button
          className={view === "today" ? "active" : ""}
          onClick={() => setView("today")}
        >
          <Home />
          <span>今日</span>
        </button>
        <button
          className={view === "orders" ? "active" : ""}
          onClick={() => setView("orders")}
          disabled={!workbench}
        >
          <Clock3 />
          <span>订单</span>
        </button>
        <button
          className={view === "shifts" ? "active" : ""}
          onClick={() => setView("shifts")}
          disabled={!workbench}
        >
          <CalendarDays />
          <span>排班</span>
        </button>
        <button
          className={view === "profile" ? "active" : ""}
          onClick={() => setView("profile")}
          disabled={!workbench}
        >
          <UserRound />
          <span>我的</span>
        </button>
      </nav>
    </div>
  );
}

function TodayView({
  workbench,
  earnings,
  nextOrder,
  loading,
  savingOrderId,
  onRefresh,
  onAdvance,
  routeByOrder,
  onReportAndRoute,
  onOpenNavigation,
  onNavigate,
}: {
  workbench: TechnicianWorkbench;
  earnings: TechnicianEarnings | null;
  nextOrder: TechnicianWorkbenchOrder | null;
  loading: boolean;
  savingOrderId: string;
  onRefresh: () => void;
  onAdvance: (order: TechnicianWorkbenchOrder) => Promise<boolean>;
  routeByOrder: Record<string, TechnicianRoute>;
  onReportAndRoute: (order: TechnicianWorkbenchOrder) => Promise<void>;
  onOpenNavigation: (order: TechnicianWorkbenchOrder) => void;
  onNavigate: (view: WorkbenchView) => void;
}) {
  return (
    <>
      <section className="status-card">
        <div className="status-top">
          <div>
            <span className="dot" />
            工作台已连接
          </div>
          <span className="safe-label">隐私保护中</span>
        </div>
        <div className="numbers">
          <div>
            <strong>{workbench.metrics.todayOrders}</strong>
            <span>今日订单</span>
          </div>
          <div>
            <strong>{workbench.metrics.activeOrders}</strong>
            <span>履约中</span>
          </div>
          <div>
            <strong>{workbench.metrics.completedOrders}</strong>
            <span>已完成</span>
          </div>
        </div>
        <small>订单、排班与技师资料均实时读取管理后台同一数据库</small>
      </section>

      {earnings && <EarningsCard earnings={earnings} compact />}

      <section className="section-head">
        <div>
          <h2>下一单</h2>
          <p>已授权技师可查看本人订单的上门地址，不展示客户电话</p>
        </div>
        <button onClick={onRefresh} disabled={loading}>
          刷新
        </button>
      </section>
      {nextOrder ? (
        <NextOrder
          order={nextOrder}
          busy={savingOrderId === nextOrder.id}
          onAdvance={onAdvance}
          route={routeByOrder[nextOrder.id]}
          onReportAndRoute={onReportAndRoute}
          onOpenNavigation={onOpenNavigation}
        />
      ) : (
        <div className="empty-state">今天暂无待服务订单</div>
      )}

      <section className="quick">
        <button onClick={() => onNavigate("shifts")}>
          <CalendarDays />
          <span>
            我的排班
            <small>本周 {workbench.metrics.weeklyShifts} 个班次</small>
          </span>
          <ChevronRight />
        </button>
        <button onClick={() => onNavigate("orders")}>
          <Clock3 />
          <span>
            服务记录
            <small>今日完成 {workbench.metrics.completedOrders} 单</small>
          </span>
          <ChevronRight />
        </button>
      </section>

      <section className="section-head">
        <div>
          <h2>今日安排</h2>
          <p>{workbench.day} · 郑州时间</p>
        </div>
      </section>
      <OrderTimeline orders={workbench.orders} nextOrderId={nextOrder?.id} />
    </>
  );
}

function EarningsCard({
  earnings,
  compact = false,
}: {
  earnings: TechnicianEarnings;
  compact?: boolean;
}) {
  return (
    <section className={`earnings-card${compact ? " compact" : ""}`}>
      <div className="earnings-head">
        <div>
          <span>本月服务流水</span>
          <small>仅统计客户已确认完成的订单</small>
        </div>
        <WalletCards size={20} />
      </div>
      <div className="earnings-metrics">
        <div>
          <strong>{formatMoney(earnings.metrics.grossOrderAmountFen)}</strong>
          <span>订单总额 · {earnings.metrics.completedOrders} 单</span>
        </div>
        <div>
          <strong>待核算</strong>
          <span>可结算金额</span>
        </div>
      </div>
      <p>{earnings.settlement.notice}</p>
      {!compact && earnings.items.length > 0 && (
        <div className="earning-items">
          {earnings.items.map((item) => (
            <div key={item.orderId}>
              <span>
                {item.serviceName}
                <small>
                  {item.orderNo} · {formatDay(item.completedAt)}
                </small>
              </span>
              <b>{formatMoney(item.grossOrderAmountFen)}</b>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function OrderTimeline({
  orders,
  nextOrderId,
}: {
  orders: TechnicianWorkbenchOrder[];
  nextOrderId?: string;
}) {
  return (
    <div className="timeline">
      {orders.map((order) => (
        <article
          className={
            ["COMPLETED", "CANCELLED", "REFUNDED"].includes(order.status)
              ? "muted"
              : ""
          }
          key={order.id}
        >
          <time>{formatTime(order.appointmentStart)}</time>
          <i className={order.id === nextOrderId ? "active" : ""} />
          <div>
            <span>{statusLabels[order.status] ?? order.status}</span>
            <h4>
              {order.serviceName} · {order.durationMinutes} 分钟
            </h4>
            <p>
              <Clock3 size={13} />
              {formatTime(order.appointmentStart)}–
              {formatTime(order.appointmentEnd)}
            </p>
          </div>
        </article>
      ))}
      {orders.length === 0 && (
        <div className="timeline-empty">今日暂无安排</div>
      )}
    </div>
  );
}

function OrdersView({
  workbench,
  savingOrderId,
  onAdvance,
  routeByOrder,
  onReportAndRoute,
  onOpenNavigation,
}: {
  workbench: TechnicianWorkbench;
  savingOrderId: string;
  onAdvance: (order: TechnicianWorkbenchOrder) => Promise<boolean>;
  routeByOrder: Record<string, TechnicianRoute>;
  onReportAndRoute: (order: TechnicianWorkbenchOrder) => Promise<void>;
  onOpenNavigation: (order: TechnicianWorkbenchOrder) => void;
}) {
  return (
    <section className="view-page">
      <div className="view-summary">
        <span>今日全部订单</span>
        <strong>{workbench.orders.length}</strong>
        <small>只显示本人订单、服务时间与上门地址，不展示客户电话</small>
      </div>
      <div className="order-card-list">
        {workbench.orders.map((order) => (
          <NextOrder
            key={order.id}
            order={order}
            busy={savingOrderId === order.id}
            onAdvance={onAdvance}
            route={routeByOrder[order.id]}
            onReportAndRoute={onReportAndRoute}
            onOpenNavigation={onOpenNavigation}
          />
        ))}
        {workbench.orders.length === 0 && (
          <div className="empty-state">今天暂无服务订单</div>
        )}
      </div>
    </section>
  );
}

function ShiftsView({ workbench }: { workbench: TechnicianWorkbench }) {
  const shifts = workbench.shifts ?? [];
  return (
    <section className="view-page">
      <div className="view-summary">
        <span>本周有效排班</span>
        <strong>{shifts.length}</strong>
        <small>排班按 Asia/Shanghai 时区展示</small>
      </div>
      <div className="shift-list">
        {shifts.map((shift) => (
          <article key={shift.id}>
            <CalendarDays size={19} />
            <div>
              <strong>{formatDay(shift.startsAt)}</strong>
              <span>
                {formatTime(shift.startsAt)}–{formatTime(shift.endsAt)}
              </span>
            </div>
            <em>{shift.status === "ACTIVE" ? "有效" : "已取消"}</em>
          </article>
        ))}
        {shifts.length === 0 && (
          <div className="empty-state">本周暂无有效排班</div>
        )}
      </div>
    </section>
  );
}

function ProfileView({
  workbench,
  earnings,
  token,
  onLogout,
}: {
  workbench: TechnicianWorkbench;
  earnings: TechnicianEarnings | null;
  token: string;
  onLogout: () => Promise<void>;
}) {
  const [profile, setProfile] = useState<TechnicianProfile | null>(null);
  const [draft, setDraft] = useState<TechnicianProfileDraft | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [photoPreviews, setPhotoPreviews] = useState<Record<string, string>>({});

  const loadProfile = useCallback(async () => {
    setProfileLoading(true);
    setProfileError("");
    try {
      const response = await apiRequest<{ data: TechnicianProfile }>(
        TECHNICIAN_PROFILE_PATHS.profile,
        {},
        token,
      );
      setProfile(response.data);
      setDraft(profileDraftFrom(response.data));
    } catch (caught) {
      setProfileError(
        caught instanceof Error ? caught.message : "个人资料读取失败",
      );
    } finally {
      setProfileLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    let active = true;
    const blobUrls: string[] = [];
    const urls = [profile?.avatarUrl, ...(profile?.galleryUrls ?? [])].filter((url): url is string => Boolean(url));
    void Promise.all(urls.map(async (url) => {
      const preview = await loadTechnicianPhotoPreview(url, API_BASE_URL, TECHNICIAN_PROFILE_PATHS.profile, token);
      if (preview.startsWith("blob:")) blobUrls.push(preview);
      return [url, preview] as const;
    })).then((entries) => {
      if (active) setPhotoPreviews(Object.fromEntries(entries));
      else blobUrls.forEach((url) => URL.revokeObjectURL(url));
    }).catch(() => { blobUrls.forEach((url) => URL.revokeObjectURL(url)); if (active) setProfileError("照片预览读取失败，请刷新后重试"); });
    return () => { active = false; blobUrls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [profile, token]);

  async function uploadProfilePhoto(file: File | undefined, kind: "AVATAR" | "GALLERY") {
    if (!file || profileSaving) return;
    if (!window.confirm("确认上传本人已授权照片，审核后公开给客户？请勿上传身份证、证件号码、他人肖像或未经授权的照片。")) return;
    setProfileSaving(true); setProfileError(""); setProfileMessage("");
    try {
      const base64 = await prepareTechnicianPhoto(file);
      const response = await apiRequest<{ data: TechnicianPhotoUploadResult }>(`${TECHNICIAN_PROFILE_PATHS.profile}/photos`, { method: "POST", body: JSON.stringify({ kind, base64, authorized: true }) }, token);
      setProfile(response.data.profile);
      setDraft((current) => ({ ...current, ...(kind === "AVATAR" ? { avatarUrl: response.data.publicUrl } : { galleryUrls: response.data.profile.galleryUrls }) }));
      setProfileMessage("照片已保存并同步后台，审核发布后展示给客户；姓名、年龄段可后续补录。");
    } catch (caught) { setProfileError(caught instanceof Error ? caught.message : "照片上传失败"); }
    finally { setProfileSaving(false); }
  }

  async function saveProfile(showConfirmation = true) {
    if (!draft || profileSaving) return null;
    setProfileSaving(true);
    setProfileError("");
    setProfileMessage("");
    try {
      const response = await apiRequest<{ data: TechnicianProfile }>(
        TECHNICIAN_PROFILE_PATHS.profile,
        { method: "PATCH", body: JSON.stringify(draft) },
        token,
      );
      setProfile(response.data);
      setDraft(profileDraftFrom(response.data));
      if (showConfirmation) setProfileMessage("资料草稿已同步到管理后台。");
      return response.data;
    } catch (caught) {
      setProfileError(caught instanceof Error ? caught.message : "资料保存失败");
      return null;
    } finally {
      setProfileSaving(false);
    }
  }

  async function submitProfile() {
    const saved = await saveProfile(false);
    if (!saved) return;
    setProfileSaving(true);
    setProfileError("");
    try {
      const response = await apiRequest<{ data: TechnicianProfile }>(
        TECHNICIAN_PROFILE_PATHS.submitReview,
        { method: "POST", body: "{}" },
        token,
      );
      setProfile(response.data);
      setDraft(profileDraftFrom(response.data));
      setProfileMessage("资料已提交后台审核，审核完成后才会对客户公开。");
    } catch (caught) {
      setProfileError(caught instanceof Error ? caught.message : "提交审核失败");
    } finally {
      setProfileSaving(false);
    }
  }

  const profileLocked = profile?.status === "PENDING_REVIEW";

  return (
    <section className="view-page profile-page">
      <div className="profile-card">
        {profile?.avatarUrl ? (
          <img
            className="profile-avatar profile-avatar-image"
            src={photoPreviews[profile.avatarUrl] || profile.avatarUrl}
            alt="本人授权的技师照片"
          />
        ) : (
          <div className="profile-avatar">技</div>
        )}
        <div>
          <strong>{profile?.publicName || workbench.displayName}</strong>
          <span>
            {profile
              ? `${profileStatusLabels[profile.status]} · 与管理后台同步`
              : "已授权技师 · 工作台已连接"}
          </span>
        </div>
      </div>
      <section className="profile-editor">
        <div className="profile-editor-heading">
          <div>
            <h2>公开资料</h2>
            <p>保存到统一后台；只有管理员审核并发布后客户才可查看。</p>
          </div>
          {profile && (
            <em className={`profile-status status-${profile.status.toLowerCase()}`}>
              {profileStatusLabels[profile.status]}
            </em>
          )}
        </div>
        {profileLoading && <div className="profile-empty">正在读取资料…</div>}
        {profileError && <div className="profile-form-error">{profileError}</div>}
        {profileMessage && (
          <div className="profile-form-success">{profileMessage}</div>
        )}
        {profile?.rejectionReason && (
          <div className="profile-review-note">
            <strong>后台退回原因</strong>
            <p>{profile.rejectionReason}</p>
          </div>
        )}
        {draft && (
          <div className="profile-form">
            <label>
              客户端公开称呼（可留空）
              <input
                value={draft.publicName ?? ""}
                maxLength={40}
                disabled={profileLocked}
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? { ...current, publicName: event.target.value }
                      : current,
                  )
                }
              />
            </label>
            <label>
              年龄段（可留空）
              <select disabled={profileLocked} value={draft.ageRange ?? ""} onChange={(event) => setDraft((current) => current ? { ...current, ageRange: (event.target.value || null) as TechnicianProfileDraft["ageRange"] } : current)}>
                <option value="">暂不填写/不展示</option><option value="18-23岁">18-23岁</option><option value="24-29岁">24-29岁</option><option value="30-39岁">30-39岁</option><option value="40岁及以上">40岁及以上</option>
              </select>
            </label>
            <label>
              上传本人头像照片
              <input type="file" accept="image/jpeg,image/png" disabled={profileSaving || profileLocked} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void uploadProfilePhoto(file, "AVATAR"); }} />
              <small>自动压缩并去除照片定位等隐藏信息，不能上传证件文件。</small>
            </label>
            <label>
              添加详情页相册照片（最多12张）
              <input type="file" accept="image/jpeg,image/png" disabled={profileSaving || profileLocked || (draft.galleryUrls?.length ?? 0) >= 12} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void uploadProfilePhoto(file, "GALLERY"); }} />
              <div>{(profile?.galleryUrls ?? []).map((url) => <img key={url} src={photoPreviews[url] || url} alt="本人授权的相册照片" style={{ width: 75, height: 100, objectFit: "cover", borderRadius: 10, margin: 4 }} />)}</div>
            </label>
            <label>
              头像 HTTPS 地址
              <input
                inputMode="url"
                value={draft.avatarUrl ?? ""}
                disabled={profileLocked}
                placeholder="仅填写已获授权的本人照片地址"
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? { ...current, avatarUrl: event.target.value || null }
                      : current,
                  )
                }
              />
            </label>
            <label>
              个人简介
              <textarea
                value={draft.introduction ?? ""}
                maxLength={2000}
                rows={5}
                disabled={profileLocked}
                placeholder="填写真实的服务经历、沟通风格与服务边界"
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? { ...current, introduction: event.target.value }
                      : current,
                  )
                }
              />
            </label>
            <label>
              擅长项目（逗号或换行分隔）
              <textarea
                value={(draft.specialties ?? []).join("\n")}
                rows={3}
                disabled={profileLocked}
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          specialties: splitProfileList(event.target.value),
                        }
                      : current,
                  )
                }
              />
            </label>
            <label>
              从业年限
              <input
                type="number"
                min={0}
                max={60}
                value={draft.serviceYears ?? ""}
                disabled={profileLocked}
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          serviceYears: event.target.value
                            ? Number(event.target.value)
                            : null,
                        }
                      : current,
                  )
                }
              />
            </label>
            <label>
              生活照/工作照 HTTPS 地址（每行一张）
              <textarea
                value={(draft.galleryUrls ?? []).join("\n")}
                rows={4}
                disabled={profileLocked}
                placeholder="最多 12 张，仅使用本人已授权照片"
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          galleryUrls: splitProfileList(event.target.value),
                        }
                      : current,
                  )
                }
              />
            </label>
            <label>
              已提交核验的资质名称（每行一项）
              <textarea
                value={(draft.certificates ?? []).join("\n")}
                rows={3}
                disabled={profileLocked}
                placeholder="不得填写未取得或未提交核验的资质"
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          certificates: splitProfileList(event.target.value),
                        }
                      : current,
                  )
                }
              />
              <small>不要填写身份证号、证件号码或其他敏感信息。</small>
            </label>
            <div className="profile-form-actions">
              <button
                className="secondary"
                disabled={profileSaving || profileLocked}
                onClick={() => void saveProfile()}
              >
                {profileSaving ? "同步中…" : "保存草稿"}
              </button>
              <button
                disabled={
                  profileSaving ||
                  profileLocked ||
                  !profile ||
                  !["DRAFT", "REJECTED"].includes(profile.status)
                }
                onClick={() => void submitProfile()}
              >
                提交后台审核
              </button>
            </div>
          </div>
        )}
      </section>
      {profile && (
        <section className="profile-reviews">
          <div className="profile-editor-heading">
            <div>
              <h2>客户评价</h2>
              <p>评价来自已完成订单，只读展示，技师不能修改。</p>
            </div>
            <strong>
              {profile.reviewSummary.averageRating?.toFixed(1) ?? "暂无"}
              <small>{profile.reviewSummary.reviewCount} 条</small>
            </strong>
          </div>
          {profile.recentReviews.map((review) => (
            <article key={review.id}>
              <div>
                <b>{review.customerAlias}</b>
                <span>{"★".repeat(review.rating)}</span>
              </div>
              <p>{review.content}</p>
              <time>{new Date(review.createdAt).toLocaleDateString("zh-CN")}</time>
            </article>
          ))}
          {profile.recentReviews.length === 0 && (
            <div className="profile-empty">暂时没有已发布评价</div>
          )}
        </section>
      )}
      {earnings && <EarningsCard earnings={earnings} />}
      <div className="privacy-card">
        <ShieldAlert size={20} />
        <div>
          <strong>隐私与权限边界</strong>
          <p>
            仅能查看本人排班与本人订单；上门地址仅供履约导航，不展示客户电话。
          </p>
        </div>
      </div>
      <button className="logout-wide" onClick={() => void onLogout()}>
        退出当前技师账号
      </button>
    </section>
  );
}

function NextOrder({
  order,
  busy,
  onAdvance,
  route,
  onReportAndRoute,
  onOpenNavigation,
}: {
  order: TechnicianWorkbenchOrder;
  busy: boolean;
  onAdvance: (order: TechnicianWorkbenchOrder) => Promise<boolean>;
  route?: TechnicianRoute;
  onReportAndRoute: (order: TechnicianWorkbenchOrder) => Promise<void>;
  onOpenNavigation: (order: TechnicianWorkbenchOrder) => void;
}) {
  const operation = actionByStatus[order.status];
  return (
    <article className="next-order">
      <div className="accent" />
      <div className="order-top">
        <span>{statusLabels[order.status] ?? order.status}</span>
        <small>订单 {order.orderNo}</small>
      </div>
      <h3>
        {order.serviceName} <em>{order.durationMinutes} 分钟</em>
      </h3>
      <div className="privacy-notice">
        <MapPin size={16} />
        <div>
          <b>{order.destination?.addressLabel ?? "上门坐标待补齐"}</b>
          <small>GCJ-02 坐标 · 不展示客户电话</small>
        </div>
      </div>
      {order.destination && (
        <div className="map-actions">
          <button disabled={busy} onClick={() => void onReportAndRoute(order)}>
            <MapPin size={15} />
            {busy ? "定位中…" : "上报位置并计算路线"}
          </button>
          <button className="primary" onClick={() => onOpenNavigation(order)}>
            <Navigation size={15} />
            一键高德导航
          </button>
          {route && (
            <p>{formatRoute(route.distanceMeters, route.durationSeconds)}</p>
          )}
        </div>
      )}
      {operation && (
        <div className="fulfillment-actions">
          <p>每次操作都会写入订单事件和审计记录，状态不可跳级。</p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void onAdvance(order)}
          >
            {busy ? "状态更新中…" : operation.label}
          </button>
        </div>
      )}
      {order.status === "AWAITING_CONFIRMATION" && (
        <div className="awaiting-customer">
          服务记录已提交，正在等待客户确认完成。
        </div>
      )}
    </article>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
