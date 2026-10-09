import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import {
  AdminStoredValueLedgerSchema,
  formatMoney,
  type AdminStoredValueLedger,
  type AuthUser,
} from "@zydj/contracts";
import {
  canViewOrganizationWallet,
  financeOrganizationIds,
  rechargeStatusLabels,
  storedValueLedgerPath,
  storedValueTransactionLabel,
} from "./stored-value-ledger";
import { createLatestRequest, useBackgroundRefresh } from "./synchronization";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
const dateTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

export function StoredValueLedgerWorkspace({
  token,
  user,
  preferredOrganizationId,
}: {
  token: string;
  user: AuthUser | null;
  preferredOrganizationId: string;
}) {
  const organizations = financeOrganizationIds(user);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState(
    preferredOrganizationId,
  );
  const organizationId = organizations.includes(selectedOrganizationId)
    ? selectedOrganizationId
    : (organizations[0] ?? "");
  if (!token || !canViewOrganizationWallet(user, organizationId)) {
    return (
      <section className="catalog-workspace">
        <div className="catalog-heading">
          <div>
            <h2>储值账户与入账流水</h2>
            <p>需当前组织财务申请、财务复核或管理员权限。</p>
          </div>
        </div>
        <div className="catalog-gate">
          <ShieldCheck size={20} />
          <strong>身份验证后才能读取储值账本</strong>
        </div>
      </section>
    );
  }
  return (
    <section className="catalog-workspace wallet-ledger-workspace">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">STORED VALUE LEDGER</span>
          <h2>储值账户与入账流水</h2>
          <p>充值和首充红包分别列账；金额与状态以服务端确认记录为准。</p>
        </div>
        <label className="wallet-ledger-organization">
          组织
          <select
            value={organizationId}
            onChange={(event) => setSelectedOrganizationId(event.target.value)}
          >
            {organizations.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      </div>
      <LedgerDetails
        key={`${token}:${organizationId}`}
        token={token}
        organizationId={organizationId}
      />
    </section>
  );
}

function LedgerDetails({
  token,
  organizationId,
}: {
  token: string;
  organizationId: string;
}) {
  const [ledger, setLedger] = useState<AdminStoredValueLedger | null>(null);
  const [customerInput, setCustomerInput] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requests = useMemo(createLatestRequest, []);
  const load = useCallback(async () => {
    const isCurrent = requests.begin();
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `${API_BASE_URL}${storedValueLedgerPath(organizationId, customerId, limit)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(result.message || `账本读取失败（${response.status}）`);
      const value = AdminStoredValueLedgerSchema.parse(result.data);
      if (value.organizationId !== organizationId)
        throw new Error("账本组织不一致，请重新登录后查询");
      if (isCurrent()) setLedger(value);
    } catch (caught) {
      if (!isCurrent()) return;
      setLedger(null);
      setError(caught instanceof Error ? caught.message : "储值账本读取失败");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [organizationId, customerId, limit, token, requests]);
  useEffect(() => {
    setLedger(null);
    void load();
  }, [load]);
  useEffect(() => () => requests.invalidate(), [requests]);
  useBackgroundRefresh(() => void load(), !loading);

  return (
    <>
      <form
        className="wallet-ledger-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (customerInput.trim() === customerId) void load();
          else setCustomerId(customerInput.trim());
        }}
      >
        <label>
          客户用户 ID
          <input
            value={customerInput}
            maxLength={128}
            onChange={(event) => setCustomerInput(event.target.value)}
            placeholder="留空查看当前组织"
          />
        </label>
        <label>
          每类最多记录
          <select
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
          >
            <option value={50}>50 条</option>
            <option value={100}>100 条</option>
          </select>
        </label>
        <button className="primary-action" disabled={loading} type="submit">
          查询
        </button>
        <button
          className="ghost-action"
          disabled={loading}
          type="button"
          onClick={() => void load()}
        >
          <RefreshCw size={15} className={loading ? "spinning" : ""} />
          刷新
        </button>
      </form>
      {error && (
        <div className="catalog-error" role="alert">
          {error}
        </div>
      )}
      {loading && !ledger && (
        <div className="catalog-empty">正在读取组织储值账本…</div>
      )}
      {ledger && (
        <>
          <div className="wallet-ledger-summary">
            <article>
              <span>余额合计</span>
              <strong>{formatMoney(ledger.summary.balanceFen)}</strong>
            </article>
            <article>
              <span>累计成功充值</span>
              <strong>
                {formatMoney(ledger.summary.successfulRechargeFen)}
              </strong>
            </article>
            <article>
              <span>成功充值笔数</span>
              <strong>{ledger.summary.successfulRechargeCount}</strong>
            </article>
          </div>
          <p className="wallet-ledger-note">
            汇总涵盖{customerId ? "指定客户" : "当前组织"}全部记录，各类明细最多{" "}
            {ledger.limit} 条。最近读取：{dateTime(ledger.generatedAt)}；每 15
            秒更新，回到页面时也会刷新。
          </p>
          <section className="panel wallet-ledger-section">
            <h3>充值记录</h3>
            <div className="wallet-ledger-table">
              <table>
                <thead>
                  <tr>
                    <th>客户</th>
                    <th>充值金额与状态</th>
                    <th>支付流水</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.recharges.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <strong>{entry.customer.displayName}</strong>
                        <small>{entry.customer.userId}</small>
                      </td>
                      <td>
                        <strong>{formatMoney(entry.amountFen)}</strong>
                        <span
                          className={
                            entry.status === "UNKNOWN"
                              ? "wallet-review-required"
                              : ""
                          }
                        >
                          {rechargeStatusLabels[entry.status]}
                        </span>
                        {entry.prepayFailureCode && (
                          <small>支付提示：{entry.prepayFailureCode}</small>
                        )}
                      </td>
                      <td>
                        <small>充值记录 {entry.id}</small>
                        <small>商户单号 {entry.merchantPaymentNo}</small>
                        <small>
                          微信流水 {entry.providerTransactionId ?? "尚未确认"}
                        </small>
                      </td>
                      <td>
                        <small>创建 {dateTime(entry.createdAt)}</small>
                        <small>
                          {entry.succeededAt
                            ? `成功 ${dateTime(entry.succeededAt)}`
                            : "尚无成功时间记录"}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {ledger.recharges.length === 0 && (
              <div className="catalog-empty">没有匹配的充值记录</div>
            )}
            {ledger.hasMore.recharges && (
              <p className="wallet-ledger-note">
                还有更早的充值记录，请按客户用户 ID 缩小查询范围。
              </p>
            )}
          </section>
          <section className="panel wallet-ledger-section">
            <h3>入账流水 · 充值与首充红包</h3>
            <div className="wallet-ledger-table">
              <table>
                <thead>
                  <tr>
                    <th>客户与类型</th>
                    <th>本次变动</th>
                    <th>变动后余额</th>
                    <th>来源与时间</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.transactions.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <strong>{entry.customer.displayName}</strong>
                        <small>{entry.customer.userId}</small>
                        <span>{storedValueTransactionLabel(entry.type)}</span>
                      </td>
                      <td>
                        <strong>
                          {entry.changeFen > 0 ? "+" : ""}
                          {formatMoney(entry.changeFen)}
                        </strong>
                        <small>{entry.description}</small>
                      </td>
                      <td>{formatMoney(entry.balanceAfterFen)}</td>
                      <td>
                        <small>{dateTime(entry.occurredAt)}</small>
                        <small>流水 {entry.id}</small>
                        {entry.rechargeId && (
                          <small>关联充值 {entry.rechargeId}</small>
                        )}
                        {entry.rewardId && (
                          <small>关联红包 {entry.rewardId}</small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {ledger.transactions.length === 0 && (
              <div className="catalog-empty">没有已入账的流水</div>
            )}
            {ledger.hasMore.transactions && (
              <p className="wallet-ledger-note">
                还有更早的流水，请按客户用户 ID 缩小查询范围。
              </p>
            )}
          </section>
          <section className="panel wallet-ledger-section">
            <h3>客户储值账户</h3>
            <div className="wallet-ledger-table">
              <table>
                <thead>
                  <tr>
                    <th>客户</th>
                    <th>账户</th>
                    <th>当前余额</th>
                    <th>最近更新</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.accounts.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <strong>{entry.customer.displayName}</strong>
                        <small>{entry.customer.userId}</small>
                      </td>
                      <td>{entry.id}</td>
                      <td>{formatMoney(entry.balanceFen)}</td>
                      <td>{dateTime(entry.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {ledger.accounts.length === 0 && (
              <div className="catalog-empty">没有匹配的储值账户</div>
            )}
            {ledger.hasMore.accounts && (
              <p className="wallet-ledger-note">
                还有更多账户，请按客户用户 ID 缩小查询范围。
              </p>
            )}
          </section>
        </>
      )}
    </>
  );
}
