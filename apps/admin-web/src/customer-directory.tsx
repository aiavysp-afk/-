import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, RefreshCw, ShieldCheck, UsersRound } from "lucide-react";
import {
  AdminCustomerDirectorySchema,
  AdminCustomerPhoneRevealSchema,
} from "@zydj/contracts";
import {
  createCustomerPhoneDisclosure,
  customerDirectoryError,
  customerDirectoryPaths,
  safeCustomerMaskedPhone,
  validCustomerPhoneReason,
  type CustomerDirectoryItem,
  type CustomerDirectoryPage,
  type CustomerPhoneDisclosure,
} from "./customer-center";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";

export function requestCustomerDirectory(
  path: string,
  token: string,
  signal: AbortSignal,
): Promise<CustomerDirectoryPage>;
export function requestCustomerDirectory(
  path: string,
  token: string,
  signal: AbortSignal,
  reason: string,
): Promise<CustomerPhoneDisclosure>;
export async function requestCustomerDirectory(
  path: string,
  token: string,
  signal: AbortSignal,
  reason?: string,
): Promise<CustomerDirectoryPage | CustomerPhoneDisclosure> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: reason === undefined ? "GET" : "POST",
    cache: "no-store",
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(reason === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(reason === undefined ? {} : { body: JSON.stringify({ reason }) }),
  });
  // Never reflect response messages here: an upstream error could contain PII.
  if (!response.ok) throw new Error(customerDirectoryError(response.status));
  const result = (await response.json()) as { data?: unknown };
  const parsed =
    reason === undefined
      ? AdminCustomerDirectorySchema.safeParse(result.data)
      : AdminCustomerPhoneRevealSchema.safeParse(result.data);
  if (!parsed.success) throw new Error(customerDirectoryError(500));
  return parsed.data;
}

export function CustomerDirectory({
  token,
  organizationId,
}: {
  token: string;
  organizationId: string;
}) {
  if (!token || !organizationId) {
    return (
      <div className="catalog-gate">
        <ShieldCheck size={20} />
        <p>客户手机号资料需要登录并选择已授权组织，未登录不会读取客户信息。</p>
      </div>
    );
  }
  // Changing either identity destroys the entire previous scope before rendering data.
  return (
    <CustomerDirectoryScope
      key={`${organizationId}\u0000${token}`}
      token={token}
      organizationId={organizationId}
    />
  );
}

function CustomerDirectoryScope({
  token,
  organizationId,
}: {
  token: string;
  organizationId: string;
}) {
  const [customers, setCustomers] = useState<CustomerDirectoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [revealingUserId, setRevealingUserId] = useState<string | null>(null);
  const [disclosure, setDisclosure] = useState<CustomerPhoneDisclosure | null>(
    null,
  );
  const paths = useMemo(
    () => customerDirectoryPaths(organizationId),
    [organizationId],
  );
  const listRequest = useRef<{
    generation: number;
    controller: AbortController | null;
  }>({
    generation: 0,
    controller: null,
  });
  const phone = useMemo(() => createCustomerPhoneDisclosure(setDisclosure), []);

  const hidePhone = useCallback(() => {
    phone.clear();
    setRevealingUserId(null);
    setSelectedUserId(null);
    setReason("");
  }, [phone]);

  const load = useCallback(
    async (cursor?: string | null) => {
      hidePhone();
      listRequest.current.controller?.abort();
      const generation = ++listRequest.current.generation;
      const controller = new AbortController();
      listRequest.current.controller = controller;
      const isCurrent = () =>
        listRequest.current.generation === generation &&
        !controller.signal.aborted;
      setLoading(true);
      setError("");
      if (!cursor) {
        setCustomers([]);
        setNextCursor(null);
      }
      try {
        const page = await requestCustomerDirectory(
          paths.list(cursor),
          token,
          controller.signal,
        );
        if (!isCurrent()) return;
        if (!Array.isArray(page.items))
          throw new Error(customerDirectoryError(500));
        setCustomers((previous) => {
          const merged = cursor ? [...previous, ...page.items] : page.items;
          return [
            ...new Map(merged.map((item) => [item.userId, item])).values(),
          ];
        });
        setNextCursor(page.nextCursor || null);
      } catch {
        if (isCurrent())
          setError("客户列表暂时无法读取，请确认当前组织权限后重试。");
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [hidePhone, paths, token],
  );

  useEffect(() => {
    void load();
    return () => {
      listRequest.current.generation += 1;
      listRequest.current.controller?.abort();
    };
  }, [load]);

  useEffect(() => {
    const onHidden = () => {
      if (document.hidden) hidePhone();
    };
    window.addEventListener("blur", hidePhone);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("blur", hidePhone);
      document.removeEventListener("visibilitychange", onHidden);
      // clear also supports React StrictMode's effect cleanup/setup cycle.
      phone.clear();
    };
  }, [hidePhone, phone]);

  async function reveal(customer: CustomerDirectoryItem) {
    if (!validCustomerPhoneReason(reason) || !customer.phoneVerified) return;
    if (document.hidden || !document.hasFocus()) {
      hidePhone();
      return;
    }
    const ticket = phone.begin(customer.userId);
    setRevealingUserId(customer.userId);
    setError("");
    try {
      const result = await requestCustomerDirectory(
        paths.revealPhone(customer.userId),
        token,
        ticket.signal,
        reason.trim(),
      );
      if (!ticket.isCurrent()) return;
      if (!phone.show(ticket, result)) {
        setError("号码未显示，服务端授权可能已过期，请重新验证后再试。");
      } else {
        setSelectedUserId(null);
        setReason("");
      }
    } catch (caught) {
      if (ticket.isCurrent()) {
        setError(
          caught instanceof Error &&
            [
              customerDirectoryError(401),
              customerDirectoryError(403),
              customerDirectoryError(404),
              customerDirectoryError(429),
            ].includes(caught.message)
            ? caught.message
            : customerDirectoryError(500),
        );
      }
    } finally {
      if (ticket.isCurrent()) setRevealingUserId(null);
    }
  }

  return (
    <article className="panel customer-directory">
      <div className="customer-directory-heading">
        <div>
          <span className="eyebrow">AUTHORIZED CUSTOMER DIRECTORY</span>
          <h3>
            <UsersRound size={19} /> 本组织关联客户
          </h3>
          <p>
            仅显示与当前组织有订单、钱包或优惠券等业务关联的客户；尚未关联的新注册用户不会出现。
          </p>
        </div>
        <button
          className="ghost-action"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={15} className={loading ? "spinning" : ""} /> 刷新客户
        </button>
      </div>
      <p className="customer-directory-notice">
        手机号默认脱敏。查看完整号码需先在账户安全完成动态码验证，填写用途后单独授权；
        操作会留审计记录，号码最多显示 60
        秒，切换组织、刷新、离开窗口后立即隐藏。
      </p>
      {error && (
        <div className="catalog-error" role="alert">
          {error}
        </div>
      )}
      {loading && customers.length === 0 ? (
        <div className="catalog-empty">正在读取本组织关联客户…</div>
      ) : customers.length === 0 && !error ? (
        <div className="catalog-empty">
          当前组织暂无关联客户，未关联不代表用户未注册。
        </div>
      ) : (
        <div className="customer-directory-rows">
          {customers.map((customer) => (
            <section className="customer-directory-row" key={customer.userId}>
              <div className="customer-directory-identity">
                <strong>{customer.displayName || "客户"}</strong>
                <small>
                  注册于{" "}
                  {new Date(customer.createdAt).toLocaleDateString("zh-CN")}
                </small>
              </div>
              <div className="customer-directory-phone">
                <strong>
                  {disclosure?.userId === customer.userId
                    ? disclosure.phone
                    : safeCustomerMaskedPhone(customer.maskedPhone)}
                </strong>
                <small>
                  {customer.phoneVerified ? "手机号已验证" : "暂无已验证手机号"}
                </small>
              </div>
              <div>
                {disclosure?.userId === customer.userId ? (
                  <button className="ghost-action" onClick={hidePhone}>
                    <EyeOff size={15} /> 立即隐藏
                  </button>
                ) : (
                  <button
                    className="ghost-action"
                    disabled={
                      !customer.phoneVerified || Boolean(revealingUserId)
                    }
                    onClick={() => {
                      hidePhone();
                      setSelectedUserId(customer.userId);
                    }}
                  >
                    <Eye size={15} /> 申请查看完整号码
                  </button>
                )}
              </div>
              {selectedUserId === customer.userId && (
                <form
                  className="customer-directory-reason"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void reveal(customer);
                  }}
                >
                  <label>
                    查看用途（4–200 字，请勿填写手机号等隐私信息）
                    <input
                      autoComplete="off"
                      maxLength={200}
                      minLength={4}
                      required
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="例如：核实客户预约服务信息"
                    />
                  </label>
                  <p>
                    仅限业务必需；未完成账户安全动态码验证时，服务端将拒绝此操作。
                  </p>
                  <div className="catalog-actions">
                    <button
                      type="button"
                      className="ghost-action"
                      onClick={hidePhone}
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      className="primary-action"
                      disabled={
                        !validCustomerPhoneReason(reason) ||
                        Boolean(revealingUserId)
                      }
                    >
                      {revealingUserId ? "验证权限中…" : "确认用途并查看 60 秒"}
                    </button>
                  </div>
                </form>
              )}
            </section>
          ))}
        </div>
      )}
      {nextCursor && (
        <button
          className="ghost-action"
          disabled={loading}
          onClick={() => void load(nextCursor)}
        >
          {loading ? "读取中…" : "加载下一页"}
        </button>
      )}
    </article>
  );
}
