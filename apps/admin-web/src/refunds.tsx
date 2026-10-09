import { useCallback, useEffect, useRef, useState } from "react";
import {
  AdminPaymentViewSchema,
  type AdminPaymentView,
  type AuthUser,
  type RefundRequest,
  type RefundView,
} from "@zydj/contracts";
import {
  paymentHasSucceeded,
  paymentOriginLabel,
  paymentPayerLabel,
} from "./payment-origin";

const base = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
type RecordView = RefundView & {
  requestedById: string;
  reviewedById: string | null;
  events: { type: string; actorId: string | null; createdAt: string }[];
};
const money = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
const statuses: Record<string, string> = {
  REQUESTED: "待复核",
  APPROVED: "已批准待提交",
  PROCESSING: "渠道处理中",
  UNKNOWN: "结果未知，需查原单",
  ABNORMAL: "渠道异常",
  CLOSED: "渠道关闭，需人工核实",
  SUCCEEDED: "退款成功",
  REJECTED: "复核拒绝",
};

export function RefundWorkspace({
  token,
  login,
}: {
  token: string;
  login: (code: string) => Promise<void>;
}) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [payments, setPayments] = useState<AdminPaymentView[]>([]);
  const [paymentId, setPaymentId] = useState("");
  const [refunds, setRefunds] = useState<RecordView[]>([]);
  const [reason, setReason] =
    useState<RefundRequest["reason"]>("CUSTOMER_CANCELLED");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const context = `${token}:${organizationId}:${paymentId}`;
  const currentContext = useRef(context);
  currentContext.current = context;
  const request = useCallback(
    async <T,>(path: string, body?: object, key?: string): Promise<T> => {
      const response = await fetch(`${base}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.message || `请求失败（${response.status}）`);
      return result.data as T;
    },
    [token],
  );
  useEffect(() => {
    let current = true;
    setUser(null);
    setPayments([]);
    setRefunds([]);
    setPaymentId("");
    setError("");
    if (token)
      void request<AuthUser>("/auth/me")
        .then((result) => {
          if (!current) return;
          setUser(result);
          setOrganizationId(
            result.memberships.find((item) =>
              ["ADMIN", "FINANCE_APPROVER", "FINANCE_REQUESTER"].includes(
                item.role,
              ),
            )?.organizationId ?? "",
          );
        })
        .catch((caught) => {
          if (current) setError(caught.message);
        });
    return () => {
      current = false;
    };
  }, [token, request]);
  const loadPayments = useCallback(async () => {
    if (!organizationId || !token) return;
    const result = await request<unknown>(
      `/admin/organizations/${encodeURIComponent(organizationId)}/payments`,
    );
    if (currentContext.current.startsWith(`${token}:${organizationId}:`))
      setPayments(AdminPaymentViewSchema.array().parse(result));
  }, [organizationId, request, token]);
  const loadRefunds = useCallback(async () => {
    if (!paymentId || !organizationId) return;
    const expected = `${token}:${organizationId}:${paymentId}`;
    const result = await request<RecordView[]>(
      `/admin/organizations/${organizationId}/payments/${paymentId}/refunds`,
    );
    if (currentContext.current === expected) setRefunds(result);
  }, [paymentId, organizationId, request, token]);
  useEffect(() => {
    void loadPayments().catch((caught) => setError(caught.message));
  }, [loadPayments]);
  useEffect(() => {
    setRefunds([]);
    void loadRefunds().catch((caught) => setError(caught.message));
  }, [loadRefunds]);
  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      await loadPayments();
      await loadRefunds();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "请求失败");
    } finally {
      setBusy(false);
    }
  }
  async function loginAs(code: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await login(code);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }
  const roles =
    user?.memberships
      .filter((item) => item.organizationId === organizationId)
      .map((item) => item.role) ?? [];
  const canRequest = roles.some((role) =>
    ["ADMIN", "FINANCE_REQUESTER"].includes(role),
  );
  const canReview = roles.some((role) =>
    ["ADMIN", "FINANCE_APPROVER"].includes(role),
  );
  const payment = payments.find((item) => item.id === paymentId);
  return (
    <section className="catalog-workspace refund-workspace">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">REFUND CONTROL</span>
          <h2>退款申请与独立复核</h2>
          <p>
            金额由服务器计算；申请人不可复核自己。未知、异常、关闭保留额度，只查询原单。
          </p>
        </div>
        <button disabled={busy} onClick={() => void perform(async () => {})}>
          刷新
        </button>
      </div>
      {import.meta.env.DEV && (
        <div className="catalog-actions">
          <button
            disabled={busy}
            onClick={() => void loginAs("local-finance-requester")}
          >
            本地申请账号
          </button>
          <button
            disabled={busy}
            onClick={() => void loginAs("local-finance-approver")}
          >
            本地复核账号
          </button>
        </div>
      )}
      <p>
        当前身份：{user?.displayName ?? "未登录"} ·{" "}
        {roles.join(" / ") || "无财务权限"}
      </p>
      <p className="notice">
        真实渠道提交默认关闭。Mock
        成功按钮只在开发页面显示，生产后端禁止模拟操作。当前列表最多显示最近50笔支付。
      </p>
      {error && (
        <div role="alert" className="catalog-error">
          {error}
        </div>
      )}
      {user && (
        <>
          <label>
            组织{" "}
            <select
              value={organizationId}
              onChange={(e) => {
                setOrganizationId(e.target.value);
                setPaymentId("");
              }}
            >
              {[
                ...new Set(
                  user.memberships
                    .filter((item) =>
                      [
                        "ADMIN",
                        "FINANCE_APPROVER",
                        "FINANCE_REQUESTER",
                      ].includes(item.role),
                    )
                    .map((item) => item.organizationId),
                ),
              ].map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
          </label>
          <label>
            支付 / 订单{" "}
            <select
              value={paymentId}
              onChange={(e) => setPaymentId(e.target.value)}
            >
              <option value="">选择支付记录</option>
              {payments.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.orderNo} · {paymentOriginLabel(item)} · {item.status} ·{" "}
                  {money(item.amountFen)}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {payment && (
        <article className="panel refund-card">
          <h3>{payment.orderNo}</h3>
          <p>
            支付 {payment.id} · {payment.provider} · 订单 {payment.orderStatus}
          </p>
          <p>
            支付方式：<strong>{paymentOriginLabel(payment)}</strong>
          </p>
          <p>{paymentPayerLabel(payment)}</p>
          <p>支付成功时间：{payment.succeededAt ?? "尚无成功付款记录"}</p>
          {payment.kind === "FRIEND" && (
            <p className="notice">
              代付成功后资金进入平台，订单权益归下单用户。代付人不能发起退款，
              仅下单用户可按规则申请；退款按原支付渠道退回代付人。
              财务复核与渠道提交仍按现有权限及流程执行。
            </p>
          )}
          <p>
            {paymentHasSucceeded(payment) ? "实付" : "支付单金额（未确认成功）"}{" "}
            {money(payment.amountFen)} / 已退 {money(payment.refundedFen)} /
            已占用 {money(payment.reservedFen)} / 额度余额{" "}
            {money(payment.availableFen)}
          </p>
          <p>额度余额不代表当前履约状态允许自动退款，提交时服务端重新校验。</p>
          <select
            value={reason}
            onChange={(e) =>
              setReason(e.target.value as RefundRequest["reason"])
            }
          >
            <option value="CUSTOMER_CANCELLED">客户开始前取消</option>
            <option value="UNFULFILLABLE">无法履约</option>
            <option value="LATE_PAYMENT">超时后付款，待履约核实</option>
          </select>
          <button
            disabled={
              busy ||
              !canRequest ||
              payment.status !== "SUCCEEDED" ||
              payment.reservedFen > 0
            }
            onClick={() =>
              void perform(async () => {
                const storageKey = `zydj.admin.refund.${paymentId}.${reason}`;
                const key =
                  sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
                sessionStorage.setItem(storageKey, key);
                await request(
                  `/admin/organizations/${organizationId}/payments/${paymentId}/refunds`,
                  { reason },
                  key,
                );
                sessionStorage.removeItem(storageKey);
              })
            }
          >
            申请服务器计算的全额退款
          </button>
        </article>
      )}
      {refunds.map((refund) => {
        const independent = canReview && refund.requestedById !== user?.id;
        const prefix = `/admin/organizations/${organizationId}/refunds/${refund.id}`;
        return (
          <article className="panel refund-card" key={refund.id}>
            <h3>
              {statuses[refund.status]} · {money(refund.amountFen)}
            </h3>
            <p>
              {refund.id} · 策略 {refund.policyVersion}
            </p>
            <p>
              申请人 {refund.requestedById} / 复核人{" "}
              {refund.reviewedById ?? "待复核"}
            </p>
            {refund.status === "REQUESTED" && (
              <>
                <button
                  disabled={busy || !independent}
                  onClick={() =>
                    void perform(() =>
                      request(`${prefix}/approve`, { code: "CONFIRMED" }),
                    )
                  }
                >
                  独立复核通过
                </button>
                <button
                  disabled={busy || !independent}
                  onClick={() =>
                    void perform(() =>
                      request(`${prefix}/reject`, {
                        code: "INSUFFICIENT_EVIDENCE",
                      }),
                    )
                  }
                >
                  证据不足，拒绝并释放额度
                </button>
              </>
            )}
            {refund.status === "APPROVED" && (
              <button
                disabled={busy || !independent}
                onClick={() => {
                  if (
                    payment?.provider === "WECHAT" &&
                    !window.confirm(
                      "确认向微信提交真实资金退款？此操作会退款，不能通过刷新撤销。",
                    )
                  )
                    return;
                  void perform(() => request(`${prefix}/submit`, {}));
                }}
              >
                提交已复核退款
              </button>
            )}
            {["PROCESSING", "UNKNOWN", "ABNORMAL", "CLOSED"].includes(
              refund.status,
            ) &&
              payment?.provider === "WECHAT" && (
                <button
                  disabled={busy || !canReview}
                  onClick={() =>
                    void perform(() => request(`${prefix}/reconcile`, {}))
                  }
                >
                  查询原退款单
                </button>
              )}
            {import.meta.env.DEV &&
              payment?.provider === "MOCK" &&
              refund.status === "PROCESSING" && (
                <button
                  disabled={busy || !independent}
                  onClick={() =>
                    void perform(() =>
                      request(
                        `/dev/organizations/${organizationId}/refunds/${refund.id}/succeed`,
                        {},
                      ),
                    )
                  }
                >
                  仅模拟退款成功（不出款）
                </button>
              )}
            <ol>
              {refund.events.map((event, index) => (
                <li key={index}>
                  {event.createdAt} · {event.type} ·{" "}
                  {event.actorId ?? "渠道/系统"}
                </li>
              ))}
            </ol>
          </article>
        );
      })}
    </section>
  );
}
