import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import type {
  AuthSession,
  TechnicianEarnings,
  TechnicianOrderAction,
  TechnicianRoute,
  TechnicianWorkbench,
  TechnicianWorkbenchOrder,
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

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
const TOKEN_STORAGE_KEY = "zydj.technician.access-token";
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

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
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
    } catch (caught) {
      const failure = caught as Error & { status?: number };
      setWorkbench(null);
      setEarnings(null);
      setError(failure.message || "工作台加载失败");
      if (failure.status === 401) {
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        setToken("");
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  function refresh() {
    setMessage("");
    void load();
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
  }

  async function advanceOrder(order: TechnicianWorkbenchOrder) {
    const operation = actionByStatus[order.status];
    if (!operation) return;
    if (operation.confirmation && !window.confirm(operation.confirmation)) {
      return;
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "履约状态更新失败");
    } finally {
      setSavingOrderId("");
    }
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
        <button aria-label="通知功能尚未接入" disabled>
          <Bell size={19} />
        </button>
      </header>
      <main>
        {!token && (
          <section className="workbench-gate">
            <ShieldAlert size={24} />
            <h2>需要技师身份</h2>
            <p>未登录时不展示订单、排班或客户服务信息。</p>
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
                onLogout={logout}
              />
            )}
          </>
        )}
      </main>
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
  onAdvance: (order: TechnicianWorkbenchOrder) => Promise<void>;
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
        <small>开发环境 · 数据来自本地测试数据库</small>
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
  onAdvance: (order: TechnicianWorkbenchOrder) => Promise<void>;
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
  onLogout,
}: {
  workbench: TechnicianWorkbench;
  earnings: TechnicianEarnings | null;
  onLogout: () => Promise<void>;
}) {
  return (
    <section className="view-page profile-page">
      <div className="profile-card">
        <div className="profile-avatar">技</div>
        <div>
          <strong>{workbench.displayName}</strong>
          <span>已授权技师 · 工作台已连接</span>
        </div>
      </div>
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
  onAdvance: (order: TechnicianWorkbenchOrder) => Promise<void>;
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
