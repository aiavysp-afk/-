import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMoney } from "@zydj/contracts";
import { authenticatedFetch } from "./authenticated-fetch";
import "./simple-admin-pages.css";

export type SimpleAdminPageProps = {
  token: string;
  organizationId: string;
  onRequireVerification?: () => void;
  hideActions?: boolean;
};
type TechnicianRow = {
  technicianId: string;
  name: string;
  maskedPhone: string | null;
  status: string;
  version: number;
  certificatePhotos: { id: string; url: string }[];
  certificatePhotoStatus: string;
};
type OrderRow = {
  id: string;
  orderNo: string;
  customerNickname: string;
  appointmentStart: string;
  status: string;
};
type UserRow = {
  userId: string;
  displayName: string;
  maskedPhone: string | null;
  phoneVerified: boolean;
  createdAt: string;
};
type OrderDetail = OrderRow & {
  appointmentEnd: string;
  serviceAmountFen: number;
  travelFeeFen: number;
  discountFen: number;
  payableFen: number;
  createdAt: string;
  items: {
    serviceName: string;
    durationMinutes: number;
    unitPriceFen: number;
    quantity: number;
  }[];
  technicianName: string | null;
};
type Page<T> = { items: T[]; nextCursor: string | null };
type Scope = {
  alive: boolean;
  busy: boolean;
  generation: number;
  operation: number;
  controllers: Set<AbortController>;
};
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
const statusLabels: Record<string, string> = {
  PENDING_REVIEW: "待审核",
  DRAFT: "待补充资料",
  APPROVED: "审核通过",
  REJECTED: "已拒绝",
  PUBLISHED: "已发布",
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
const record = (value: unknown): value is Record<string, any> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const string = (value: unknown): value is string => typeof value === "string";
const date = (value: unknown): value is string =>
  string(value) && Number.isFinite(Date.parse(value));
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const masked = (value: unknown) =>
  value === null || (string(value) && /^1\d{2}\*{4}\d{4}$/.test(value));
function safePhotoUrl(value: unknown): value is string {
  if (!string(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
function technicianRow(value: unknown): value is TechnicianRow {
  return (
    record(value) &&
    string(value.technicianId) &&
    string(value.name) &&
    masked(value.maskedPhone) &&
    string(value.status) &&
    integer(value.version) &&
    string(value.certificatePhotoStatus) &&
    Array.isArray(value.certificatePhotos) &&
    value.certificatePhotos.every(
      (photo: unknown) =>
        record(photo) && string(photo.id) && safePhotoUrl(photo.url),
    )
  );
}
function orderRow(value: unknown): value is OrderRow {
  return (
    record(value) &&
    string(value.id) &&
    string(value.orderNo) &&
    string(value.customerNickname) &&
    date(value.appointmentStart) &&
    string(value.status)
  );
}
function userRow(value: unknown): value is UserRow {
  return (
    record(value) &&
    string(value.userId) &&
    string(value.displayName) &&
    masked(value.maskedPhone) &&
    typeof value.phoneVerified === "boolean" &&
    date(value.createdAt)
  );
}
function orderDetail(value: unknown): value is OrderDetail {
  if (!orderRow(value)) return false;
  const row = value as unknown as Record<string, unknown>;
  return (
    date(row.appointmentEnd) &&
    date(row.createdAt) &&
    (row.technicianName === null || string(row.technicianName)) &&
    [
      row.serviceAmountFen,
      row.travelFeeFen,
      row.discountFen,
      row.payableFen,
    ].every(integer) &&
    Array.isArray(row.items) &&
    row.items.every(
      (item: unknown) =>
        record(item) &&
        string(item.serviceName) &&
        integer(item.durationMinutes) &&
        item.durationMinutes > 0 &&
        integer(item.unitPriceFen) &&
        integer(item.quantity) &&
        item.quantity > 0,
    )
  );
}
function parsePage<T>(
  value: unknown,
  valid: (value: unknown) => value is T,
): Page<T> {
  if (
    !record(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(valid) ||
    !(
      value.nextCursor === null ||
      (string(value.nextCursor) &&
        /^[A-Za-z0-9_-]{1,128}$/.test(value.nextCursor))
    )
  ) {
    throw Object.assign(Error("列表返回格式异常"), { status: 502 });
  }
  return value as Page<T>;
}
function displayPhone(phone: string | null) {
  return phone && /^1\d{2}\*{4}\d{4}$/.test(phone) ? phone : "未填写";
}
function displayTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}
function apiPath(organizationId: string, suffix: string) {
  return `/admin/organizations/${encodeURIComponent(organizationId)}/${suffix}`;
}

async function request(
  scope: Scope,
  token: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  scope.controllers.add(controller);
  try {
    const response = await authenticatedFetch(token, `${API_BASE_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw Object.assign(
        Error(
          record(result) && string(result.message)
            ? result.message
            : "请求未完成",
        ),
        { status: response.status },
      );
    if (!record(result) || result.data == null)
      throw Object.assign(Error("接口返回格式异常"), { status: 502 });
    return result.data;
  } finally {
    scope.controllers.delete(controller);
  }
}
function errorText(error: unknown, onRequireVerification?: () => void) {
  const status = (error as { status?: number } | null)?.status;
  if (
    status === 403 &&
    error instanceof Error &&
    /动态码|账户安全|多因素验证/.test(error.message)
  ) {
    onRequireVerification?.();
    return "请完成弹窗中的身份验证，然后重试本次操作。";
  }
  if (status === 401) return "登录已失效，请重新登录。";
  if (
    status === 403 &&
    error instanceof Error &&
    /资料|头像|简介|证件|实名|照片|擅长/.test(error.message)
  )
    return "申请资料尚未满足审核条件，请由技师补齐资料后重新提交。";
  if (status === 403) return "当前账号没有此操作权限。";
  if (status === 409) return "资料已变化，请取消确认后刷新列表再操作。";
  if (status === 400) return "提交未完成，请检查填写信息与当前审核状态。";
  if (status === 429) return "请求较频繁，请稍后重试。";
  if (error instanceof Error && /AbortError|TimeoutError/.test(error.name))
    return "请求超时，请刷新确认结果后重试。";
  return "暂时无法完成请求，请稍后刷新重试。";
}

function useRows<T>(
  props: SimpleAdminPageProps,
  kind: string,
  valid: (value: unknown) => value is T,
) {
  const { token, organizationId } = props;
  const scope = useMemo<Scope>(
    () => ({
      alive: true,
      busy: false,
      generation: 0,
      operation: 0,
      controllers: new Set(),
    }),
    [token, organizationId, kind],
  );
  const active = useRef(scope);
  active.current = scope;
  const verification = useRef(props.onRequireVerification);
  verification.current = props.onRequireVerification;
  const empty = {
    scope,
    items: [] as T[],
    nextCursor: null as string | null,
    trail: [null] as (string | null)[],
    loading: true,
    error: "",
  };
  const [snapshot, setSnapshot] = useState(empty);
  const state = snapshot.scope === scope ? snapshot : empty;
  const isCurrent = () => active.current === scope && scope.alive;
  function update(patch: Partial<Omit<typeof empty, "scope">>) {
    if (!isCurrent()) return;
    setSnapshot((previous) =>
      isCurrent()
        ? {
            ...(previous.scope === scope ? previous : empty),
            ...patch,
          }
        : previous,
    );
  }
  const load = useCallback(
    async (cursor: string | null = null, trail: (string | null)[] = [null]) => {
      if (!isCurrent() || scope.busy || !token || !organizationId) return;
      scope.busy = true;
      const operation = ++scope.operation;
      const generation = ++scope.generation;
      const current = () => isCurrent() && generation === scope.generation;
      update({ loading: true, error: "", items: [], nextCursor: null });
      try {
        const params = new URLSearchParams({
          limit: "20",
          ...(kind === "technicians" ? { status: "PENDING_REVIEW" } : {}),
        });
        if (cursor) params.set("cursor", cursor);
        const page = parsePage(
          await request(
            scope,
            token,
            apiPath(organizationId, `simple/${kind}?${params}`),
          ),
          valid,
        );
        if (current()) update({ ...page, trail });
      } catch (error) {
        if (current())
          update({ error: errorText(error, verification.current) });
      } finally {
        if (scope.operation === operation) scope.busy = false;
        if (current()) update({ loading: false });
      }
    },
    [scope, token, organizationId, kind],
  );
  useEffect(() => {
    scope.alive = true;
    if (token && organizationId) void load();
    else update({ loading: false, error: "请先登录管理账号。" });
    return () => {
      scope.alive = false;
      scope.generation++;
      scope.operation++;
      scope.busy = false;
      scope.controllers.forEach((controller) => controller.abort());
    };
  }, [scope, load, token, organizationId]);
  return {
    ...state,
    scope,
    isCurrent,
    load,
    report: (error: unknown) => errorText(error, verification.current),
  };
}
function PageLinks({
  data,
  disabled = false,
}: {
  data: {
    loading: boolean;
    nextCursor: string | null;
    trail: (string | null)[];
    items: unknown[];
    load: (cursor?: string | null, trail?: (string | null)[]) => Promise<void>;
  };
  disabled?: boolean;
}) {
  const busy = disabled || data.loading;
  return (
    <div className="simple-admin-pagination">
      <span>
        第{data.trail.length}页，本页{data.items.length}条
        {data.nextCursor ? "，还有更多记录" : ""}
      </span>
      {data.trail.length > 1 && (
        <a
          href="#previous"
          aria-disabled={busy}
          onClick={(event) => {
            event.preventDefault();
            if (!busy) {
              const trail = data.trail.slice(0, -1);
              void data.load(trail[trail.length - 1], trail);
            }
          }}
        >
          上一页
        </a>
      )}
      {data.nextCursor && (
        <a
          href="#next"
          aria-disabled={busy}
          onClick={(event) => {
            event.preventDefault();
            if (!busy && data.nextCursor)
              void data.load(data.nextCursor, [...data.trail, data.nextCursor]);
          }}
        >
          下一页
        </a>
      )}
    </div>
  );
}

export function SimpleTechniciansPage(props: SimpleAdminPageProps) {
  const data = useRows(props, "technicians", technicianRow);
  const empty = {
    scope: data.scope,
    selectedId: "",
    confirmation: null as {
      row: TechnicianRow;
      action: "approve" | "reject";
    } | null,
    reason: "",
    busy: false,
    error: "",
    notice: "",
  };
  const [snapshot, setSnapshot] = useState(empty);
  const view = snapshot.scope === data.scope ? snapshot : empty;
  function update(patch: Partial<Omit<typeof empty, "scope">>) {
    if (data.isCurrent())
      setSnapshot((previous) =>
        data.isCurrent()
          ? {
              ...(previous.scope === data.scope ? previous : empty),
              ...patch,
            }
          : previous,
      );
  }
  const selected = data.items.find(
    (row) =>
      row.technicianId === view.selectedId && row.status === "PENDING_REVIEW",
  );
  const busy = data.loading || view.busy;
  async function confirm() {
    const confirmation = view.confirmation;
    if (!confirmation || !data.isCurrent() || data.scope.busy || busy) return;
    const reason = view.reason.trim();
    if (
      confirmation.action === "reject" &&
      (reason.length < 2 || reason.length > 500)
    ) {
      update({ error: "请填写2至500字拒绝原因。" });
      return;
    }
    data.scope.busy = true;
    const operation = ++data.scope.operation;
    update({ busy: true, error: "", notice: "" });
    try {
      const { row, action } = confirmation;
      const result = await request(
        data.scope,
        props.token,
        apiPath(
          props.organizationId,
          `technicians/${encodeURIComponent(row.technicianId)}/profile/${action}`,
        ),
        {
          expectedVersion: row.version,
          ...(action === "reject" ? { reason } : {}),
        },
      );
      if (
        !record(result) ||
        result.technicianId !== row.technicianId ||
        result.status !== (action === "approve" ? "APPROVED" : "REJECTED")
      )
        throw Error("审核结果未确认");
      if (!data.isCurrent()) return;
      update({
        confirmation: null,
        selectedId: "",
        reason: "",
        notice:
          action === "approve"
            ? "审核已通过，公开展示与接单仍按现有发布及排班规则执行。"
            : "申请已拒绝，原因已同步技师端。",
      });
      if (data.scope.operation === operation) data.scope.busy = false;
      await data.load();
    } catch (error) {
      if (data.isCurrent()) update({ error: data.report(error) });
    } finally {
      if (data.scope.operation === operation) data.scope.busy = false;
      update({ busy: false });
    }
  }
  return (
    <section
      className="simple-admin-page"
      aria-labelledby="simple-technicians-title"
    >
      <div className="simple-admin-heading">
        <h2 id="simple-technicians-title">技师待审核</h2>
        {!props.hideActions && (
          <div className="simple-admin-actions">
            {view.confirmation ? (
              <>
                <button
                  className="primary-action"
                  disabled={busy}
                  aria-busy={view.busy}
                  onClick={() => void confirm()}
                >
                  {view.busy
                    ? "提交中…"
                    : view.confirmation.action === "approve"
                      ? "确认通过"
                      : "确认拒绝"}
                </button>
                <button
                  className="ghost-action"
                  disabled={view.busy}
                  onClick={() =>
                    update({ confirmation: null, reason: "", error: "" })
                  }
                >
                  取消
                </button>
              </>
            ) : (
              <>
                <button
                  className="ghost-action"
                  disabled={busy}
                  onClick={() => {
                    update({ selectedId: "", error: "", notice: "" });
                    void data.load();
                  }}
                >
                  刷新
                </button>
                <button
                  className="primary-action"
                  disabled={busy || !selected}
                  onClick={() => {
                    if (selected)
                      update({
                        confirmation: { row: selected, action: "approve" },
                        error: "",
                        notice: "",
                      });
                  }}
                >
                  通过
                </button>
                <button
                  className="danger-action"
                  disabled={busy || !selected}
                  onClick={() => {
                    if (selected)
                      update({
                        confirmation: { row: selected, action: "reject" },
                        error: "",
                        notice: "",
                      });
                  }}
                >
                  拒绝
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {(data.error || view.error) && (
        <p role="alert" className="simple-admin-error">
          {view.error || data.error}
        </p>
      )}
      {view.notice && (
        <p role="status" className="simple-admin-notice">
          {view.notice}
        </p>
      )}
      {view.confirmation && (
        <div className="simple-admin-confirm">
          <p>
            确认{view.confirmation.action === "approve" ? "通过" : "拒绝"}「
            {view.confirmation.row.name || "未填写姓名"}」的本次入驻申请？
          </p>
          {view.confirmation.action === "reject" && (
            <label>
              拒绝原因
              <textarea
                value={view.reason}
                maxLength={500}
                rows={3}
                disabled={view.busy}
                onChange={(event) =>
                  update({ reason: event.target.value, error: "" })
                }
              />
            </label>
          )}
        </div>
      )}
      <div className="simple-admin-table">
        <table>
          <thead>
            <tr>
              <th>姓名</th>
              <th>手机号</th>
              <th>证书照片</th>
              <th>审核状态</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => (
              <tr key={row.technicianId}>
                <td>
                  <label className="simple-admin-select">
                    <input
                      type="radio"
                      name="technician-review-selection"
                      checked={view.selectedId === row.technicianId}
                      disabled={
                        busy ||
                        Boolean(view.confirmation) ||
                        row.status !== "PENDING_REVIEW"
                      }
                      onChange={() =>
                        update({ selectedId: row.technicianId, error: "" })
                      }
                    />
                    {row.name || "未填写"}
                  </label>
                </td>
                <td>{displayPhone(row.maskedPhone)}</td>
                <td>
                  {row.certificatePhotos.length
                    ? row.certificatePhotos.map((photo, index) => (
                        <a
                          key={photo.id}
                          href={photo.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          查看证书{index + 1}
                        </a>
                      ))
                    : "未上传证书照片"}
                </td>
                <td>{statusLabels[row.status] ?? "状态待核实"}</td>
              </tr>
            ))}
            {!data.items.length && (
              <tr>
                <td colSpan={4}>
                  {data.loading
                    ? "正在读取…"
                    : data.error
                      ? "列表未能读取"
                      : "暂无待审核技师"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <PageLinks
        data={data}
        disabled={view.busy || Boolean(view.confirmation)}
      />
    </section>
  );
}

export function SimpleOrdersPage(props: SimpleAdminPageProps) {
  const data = useRows(props, "orders", orderRow);
  const empty = {
    scope: data.scope,
    selectedId: "",
    value: null as OrderDetail | null,
    loading: false,
    error: "",
  };
  const [snapshot, setSnapshot] = useState(empty);
  const view = snapshot.scope === data.scope ? snapshot : empty;
  const detailSequence = useRef(0);
  function update(patch: Partial<Omit<typeof empty, "scope">>) {
    if (data.isCurrent())
      setSnapshot((previous) =>
        data.isCurrent()
          ? {
              ...(previous.scope === data.scope ? previous : empty),
              ...patch,
            }
          : previous,
      );
  }
  async function showDetail(row: OrderRow) {
    if (!data.isCurrent() || data.scope.busy || view.loading) return;
    const sequence = ++detailSequence.current;
    data.scope.busy = true;
    const operation = ++data.scope.operation;
    update({ selectedId: row.id, value: null, loading: true, error: "" });
    try {
      const result = await request(
        data.scope,
        props.token,
        apiPath(
          props.organizationId,
          `simple/orders/${encodeURIComponent(row.id)}`,
        ),
      );
      if (!orderDetail(result) || result.id !== row.id)
        throw Error("订单详情返回格式异常");
      if (data.isCurrent() && sequence === detailSequence.current)
        update({ value: result });
    } catch (error) {
      if (data.isCurrent() && sequence === detailSequence.current)
        update({ error: data.report(error) });
    } finally {
      if (data.scope.operation === operation) data.scope.busy = false;
      if (data.isCurrent() && sequence === detailSequence.current)
        update({ loading: false });
    }
  }
  return (
    <section
      className="simple-admin-page"
      aria-labelledby="simple-orders-title"
    >
      <div className="simple-admin-heading">
        <h2 id="simple-orders-title">订单</h2>
        {!props.hideActions && (
          <button
            className="ghost-action"
            disabled={data.loading || view.loading}
            onClick={() => {
              detailSequence.current++;
              update({ selectedId: "", value: null, error: "" });
              void data.load();
            }}
          >
            刷新
          </button>
        )}
      </div>
      {(data.error || view.error) && (
        <p role="alert" className="simple-admin-error">
          {view.error || data.error}
        </p>
      )}
      <div className="simple-admin-table">
        <table>
          <thead>
            <tr>
              <th>订单号</th>
              <th>用户昵称</th>
              <th>预约时间</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => (
              <tr key={row.id}>
                <td>{row.orderNo}</td>
                <td>{row.customerNickname || "未填写"}</td>
                <td>{displayTime(row.appointmentStart)}</td>
                <td>{statusLabels[row.status] ?? "状态待核实"}</td>
                <td>
                  <a
                    href="#order-detail"
                    aria-disabled={data.loading || view.loading}
                    onClick={(event) => {
                      event.preventDefault();
                      void showDetail(row);
                    }}
                  >
                    查看详情
                  </a>
                </td>
              </tr>
            ))}
            {!data.items.length && (
              <tr>
                <td colSpan={5}>
                  {data.loading
                    ? "正在读取…"
                    : data.error
                      ? "列表未能读取"
                      : "暂无订单"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {view.selectedId && (
        <section
          className="simple-order-detail"
          id="order-detail"
          aria-label="订单详情"
        >
          <div className="simple-admin-heading">
            <h3>订单详情</h3>
            <a
              href="#orders"
              aria-disabled={view.loading}
              onClick={(event) => {
                event.preventDefault();
                if (view.loading) return;
                detailSequence.current++;
                update({
                  selectedId: "",
                  value: null,
                  error: "",
                  loading: false,
                });
              }}
            >
              收起详情
            </a>
          </div>
          {view.loading && <p role="status">正在读取订单详情…</p>}
          {view.value && (
            <>
              <dl>
                <div>
                  <dt>订单号</dt>
                  <dd>{view.value.orderNo}</dd>
                </div>
                <div>
                  <dt>用户</dt>
                  <dd>{view.value.customerNickname || "未填写"}</dd>
                </div>
                <div>
                  <dt>预约时间</dt>
                  <dd>
                    {displayTime(view.value.appointmentStart)} 至{" "}
                    {displayTime(view.value.appointmentEnd)}
                  </dd>
                </div>
                <div>
                  <dt>状态</dt>
                  <dd>{statusLabels[view.value.status] ?? "状态待核实"}</dd>
                </div>
                <div>
                  <dt>技师</dt>
                  <dd>{view.value.technicianName || "尚未安排"}</dd>
                </div>
              </dl>
              <ul>
                {view.value.items.map((item, index) => (
                  <li key={index}>
                    {item.serviceName} · {item.durationMinutes}分钟 ×{" "}
                    {item.quantity} · 单价{formatMoney(item.unitPriceFen)}
                  </li>
                ))}
              </ul>
              <p>
                项目费{formatMoney(view.value.serviceAmountFen)} · 出行费
                {formatMoney(view.value.travelFeeFen)} · 优惠
                {formatMoney(view.value.discountFen)}
              </p>
              <p className="simple-order-total">
                应付金额 {formatMoney(view.value.payableFen)}
              </p>
            </>
          )}
        </section>
      )}
      <PageLinks data={data} disabled={view.loading} />
    </section>
  );
}

export function SimpleUsersPage(props: SimpleAdminPageProps) {
  const data = useRows(props, "users", userRow);
  return (
    <section className="simple-admin-page" aria-labelledby="simple-users-title">
      <div className="simple-admin-heading">
        <h2 id="simple-users-title">用户</h2>
        {!props.hideActions && (
          <button
            className="ghost-action"
            disabled={data.loading}
            onClick={() => void data.load()}
          >
            刷新
          </button>
        )}
      </div>
      <p className="simple-admin-description">
        显示当前组织已登记的客户，手机号脱敏显示。
      </p>
      {data.error && (
        <p role="alert" className="simple-admin-error">
          {data.error}
        </p>
      )}
      <div className="simple-admin-table">
        <table>
          <thead>
            <tr>
              <th>昵称</th>
              <th>手机号</th>
              <th>注册时间</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => (
              <tr key={row.userId}>
                <td>{row.displayName || "未填写"}</td>
                <td>{displayPhone(row.maskedPhone)}</td>
                <td>{displayTime(row.createdAt)}</td>
              </tr>
            ))}
            {!data.items.length && (
              <tr>
                <td colSpan={3}>
                  {data.loading
                    ? "正在读取…"
                    : data.error
                      ? "列表未能读取"
                      : "暂无关联用户"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <PageLinks data={data} />
    </section>
  );
}
