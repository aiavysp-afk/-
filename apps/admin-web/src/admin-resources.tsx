import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  CircleAlert,
  CircleCheck,
  FileClock,
  MapPinned,
  RefreshCw,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import type {
  AdminReadiness,
  AdminServiceArea,
  AdminShift,
  AdminTechnicianBoard,
  AuditLogEntry,
} from "@zydj/contracts";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";

async function request<T>(path: string, token: string, body?: object) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.message || `请求失败（${response.status}）`);
  }
  return result.data as T;
}

function nextShanghaiDate() {
  return new Date(Date.now() + 8 * 60 * 60_000 + 24 * 60 * 60_000)
    .toISOString()
    .slice(0, 10);
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Gate({ title, login }: { title: string; login: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="catalog-workspace">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">AUTHORIZED WORKSPACE</span>
          <h2>{title}</h2>
          <p>登录后读取本地数据库中的真实组织数据。</p>
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
          <strong>当前页面需要授权身份</strong>
          <p>未登录不会展示技师、排班、审计或配置状态。</p>
        </div>
      </div>
      {error && <div className="catalog-error">{error}</div>}
    </section>
  );
}

export function TechniciansWorkspace({
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
  const [board, setBoard] = useState<AdminTechnicianBoard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!token || !organizationId) return;
    setLoading(true);
    setError("");
    try {
      setBoard(
        await request<AdminTechnicianBoard>(
          `/admin/organizations/${organizationId}/technicians`,
          token,
        ),
      );
    } catch (caught) {
      setBoard(null);
      setError(caught instanceof Error ? caught.message : "技师列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [organizationId, token]);
  useEffect(() => void load(), [load]);

  if (!token || !organizationId) {
    return <Gate title="技师管理" login={login} />;
  }
  const needle = query.trim().toLowerCase();
  const rows =
    board?.technicians.filter(
      (technician) =>
        !needle ||
        technician.displayName.toLowerCase().includes(needle) ||
        technician.id.toLowerCase().includes(needle),
    ) ?? [];
  const availabilityLabels = {
    ON_SHIFT: "值班中",
    SCHEDULED: "今日有班",
    OFF_DUTY: "今日无班",
  } as const;

  return (
    <section className="catalog-workspace resource-workspace">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">TECHNICIAN WORKFORCE</span>
          <h2>技师管理</h2>
          <p>仅展示组织内已启用技师、今日排班和订单数量，不展示客户隐私。</p>
        </div>
        <button
          className="ghost-action"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={15} className={loading ? "spinning" : ""} />
          刷新
        </button>
      </div>
      {error && <div className="catalog-error">{error}</div>}
      <div className="resource-grid">
        {rows.map((technician) => (
          <article className="resource-card" key={technician.id}>
            <div className="resource-icon">
              <UserRound size={20} />
            </div>
            <div className="resource-title">
              <div>
                <h3>{technician.displayName}</h3>
                <small>{technician.id}</small>
              </div>
              <em
                className={
                  technician.availability === "ON_SHIFT"
                    ? "status-on"
                    : "status-waiting"
                }
              >
                {availabilityLabels[technician.availability]}
              </em>
            </div>
            <p>
              {technician.todayShift
                ? `${formatDateTime(technician.todayShift.startsAt)}–${formatDateTime(technician.todayShift.endsAt).split(" ").at(-1)}`
                : "今日尚无有效排班"}
            </p>
            <div className="resource-metrics">
              <span>
                <b>{technician.metrics.activeOrders}</b>履约中
              </span>
              <span>
                <b>{technician.metrics.completedToday}</b>今日完成
              </span>
              <span>
                <b>
                  {technician.accountStatus === "ACTIVE"
                    ? "正常"
                    : technician.accountStatus}
                </b>
                账号
              </span>
            </div>
          </article>
        ))}
      </div>
      {!loading && rows.length === 0 && (
        <div className="catalog-empty">
          {needle ? "没有匹配的技师" : "当前组织暂无已启用技师"}
        </div>
      )}
    </section>
  );
}

export function SchedulingWorkspace({
  token,
  organizationId,
  login,
}: {
  token: string;
  organizationId: string;
  login: () => Promise<void>;
}) {
  const [date, setDate] = useState(nextShanghaiDate());
  const [technicians, setTechnicians] = useState<AdminTechnicianBoard | null>(
    null,
  );
  const [shifts, setShifts] = useState<AdminShift[]>([]);
  const [therapistId, setTherapistId] = useState("");
  const [startsAt, setStartsAt] = useState(`${date}T09:00`);
  const [endsAt, setEndsAt] = useState(`${date}T18:00`);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    if (!token || !organizationId) return;
    setLoading(true);
    setError("");
    try {
      const [board, shiftRows] = await Promise.all([
        request<AdminTechnicianBoard>(
          `/admin/organizations/${organizationId}/technicians`,
          token,
        ),
        request<AdminShift[]>(
          `/admin/scheduling/shifts?organizationId=${encodeURIComponent(organizationId)}&date=${date}`,
          token,
        ),
      ]);
      setTechnicians(board);
      setShifts(shiftRows);
      setTherapistId((current) => current || board.technicians[0]?.id || "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "排班加载失败");
    } finally {
      setLoading(false);
    }
  }, [date, organizationId, token]);
  useEffect(() => void load(), [load]);

  if (!token || !organizationId) {
    return <Gate title="排班中心" login={login} />;
  }

  async function createShift() {
    if (!therapistId || !startsAt || !endsAt) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await request("/admin/scheduling/shifts", token, {
        organizationId,
        therapistId,
        startsAt: new Date(`${startsAt}:00+08:00`).toISOString(),
        endsAt: new Date(`${endsAt}:00+08:00`).toISOString(),
      });
      setMessage("排班已创建并写入审计记录。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "排班创建失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="catalog-workspace resource-workspace">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">SHIFT SCHEDULING</span>
          <h2>排班中心</h2>
          <p>按郑州时间读取并创建排班；重叠时段由数据库和服务端共同拒绝。</p>
        </div>
        <label className="date-filter">
          日期
          <input
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              setStartsAt(`${event.target.value}T09:00`);
              setEndsAt(`${event.target.value}T18:00`);
            }}
          />
        </label>
      </div>
      {message && <div className="dispatch-message">{message}</div>}
      {error && <div className="catalog-error">{error}</div>}
      <div className="schedule-layout">
        <article className="panel schedule-form">
          <h3>
            <CalendarDays size={18} /> 创建排班
          </h3>
          <label>
            技师
            <select
              value={therapistId}
              onChange={(event) => setTherapistId(event.target.value)}
            >
              <option value="">选择技师</option>
              {technicians?.technicians.map((technician) => (
                <option key={technician.id} value={technician.id}>
                  {technician.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            开始时间
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </label>
          <label>
            结束时间
            <input
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </label>
          <button
            className="primary-action"
            disabled={saving || !therapistId}
            onClick={() => void createShift()}
          >
            {saving ? "创建中…" : "创建有效排班"}
          </button>
        </article>
        <article className="panel schedule-list">
          <h3>当日排班</h3>
          {shifts.map((shift) => (
            <div key={shift.id}>
              <span>
                <b>{shift.therapistDisplayName}</b>
                <small>
                  {formatDateTime(shift.startsAt)} 至{" "}
                  {formatDateTime(shift.endsAt)}
                </small>
              </span>
              <em
                className={
                  shift.status === "ACTIVE" ? "status-on" : "status-off"
                }
              >
                {shift.status === "ACTIVE" ? "有效" : "已取消"}
              </em>
            </div>
          ))}
          {!loading && shifts.length === 0 && (
            <div className="catalog-empty">当日暂无排班</div>
          )}
        </article>
      </div>
    </section>
  );
}

const areaNames: Record<string, string> = {
  "410102": "中原区",
  "410103": "二七区",
  "410104": "管城回族区",
  "410105": "金水区",
  "410106": "上街区",
  "410108": "惠济区",
  "410122": "中牟县",
  "410171": "经开区",
  "410172": "高新区",
  "410173": "航空港区",
  "410181": "巩义市",
  "410182": "荥阳市",
  "410183": "新密市",
  "410184": "新郑市",
  "410185": "登封市",
};

export function ServiceAreaWorkspace({
  token,
  organizationId,
  login,
}: {
  token: string;
  organizationId: string;
  login: () => Promise<void>;
}) {
  const [area, setArea] = useState<AdminServiceArea | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!token || !organizationId) return;
    setError("");
    try {
      setArea(
        await request<AdminServiceArea>(
          `/admin/organizations/${organizationId}/service-area`,
          token,
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "服务区域加载失败");
    }
  }, [organizationId, token]);
  useEffect(() => void load(), [load]);
  if (!token || !organizationId) return <Gate title="服务区域" login={login} />;
  return (
    <section className="catalog-workspace resource-workspace">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">SERVICE COVERAGE</span>
          <h2>服务区域</h2>
          <p>经营范围目标为郑州市全域，地图门禁状态与覆盖代码分开显示。</p>
        </div>
        <MapPinned size={28} />
      </div>
      {error && <div className="catalog-error">{error}</div>}
      {area && (
        <>
          <div className="coverage-summary">
            <div>
              <strong>{area.targetAdcodes.length}</strong>
              <span>目标覆盖区县/功能区</span>
            </div>
            <div>
              <strong>{area.configuredAdcodes.length}</strong>
              <span>已配置代码</span>
            </div>
            <div>
              <strong>{area.verificationEnabled ? "已启用" : "未启用"}</strong>
              <span>地图核验门禁</span>
            </div>
          </div>
          <div className="catalog-gate">
            <ShieldCheck size={20} />
            <div>
              <strong>
                {area.fullyConfigured
                  ? "郑州全域代码已齐全"
                  : "服务区代码尚未完整配置"}
              </strong>
              <p>{area.notice}</p>
            </div>
          </div>
          <div className="area-grid">
            {area.targetAdcodes.map((adcode) => (
              <div
                key={adcode}
                className={
                  area.configuredAdcodes.includes(adcode) ? "configured" : ""
                }
              >
                <span>{areaNames[adcode] ?? "郑州辖区"}</span>
                <small>{adcode}</small>
                {area.configuredAdcodes.includes(adcode) ? (
                  <CircleCheck size={15} />
                ) : (
                  <CircleAlert size={15} />
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function AuditWorkspace({
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
  const [rows, setRows] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!token || !organizationId) return;
    setLoading(true);
    setError("");
    try {
      setRows(
        await request<AuditLogEntry[]>(
          `/admin/audit-logs?organizationId=${encodeURIComponent(organizationId)}`,
          token,
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "审计记录加载失败");
    } finally {
      setLoading(false);
    }
  }, [organizationId, token]);
  useEffect(() => void load(), [load]);
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter(
        (row) =>
          !needle ||
          [row.action, row.resourceType, row.resourceId ?? ""].some((value) =>
            value.toLowerCase().includes(needle),
          ),
      ),
    [needle, rows],
  );
  if (!token || !organizationId) return <Gate title="权限审计" login={login} />;
  return (
    <section className="catalog-workspace resource-workspace">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">AUDIT TRAIL</span>
          <h2>权限审计</h2>
          <p>最近 50 条组织操作记录；不展示密钥、地址或客户电话。</p>
        </div>
        <button
          className="ghost-action"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={15} className={loading ? "spinning" : ""} />
          刷新
        </button>
      </div>
      {error && <div className="catalog-error">{error}</div>}
      <div className="panel audit-table">
        <div className="audit-row audit-head">
          <span>时间</span>
          <span>动作</span>
          <span>资源</span>
          <span>资源编号</span>
        </div>
        {filtered.map((row) => (
          <div className="audit-row" key={row.id}>
            <span>{formatDateTime(row.createdAt)}</span>
            <span>
              <FileClock size={14} />
              {row.action}
            </span>
            <span>{row.resourceType}</span>
            <span>{row.resourceId ?? "—"}</span>
          </div>
        ))}
        {!loading && filtered.length === 0 && (
          <div className="catalog-empty">没有匹配的审计记录</div>
        )}
      </div>
    </section>
  );
}

function GateState({ value }: { value: boolean }) {
  return (
    <em className={value ? "status-on" : "status-off"}>
      {value ? "已启用" : "未启用"}
    </em>
  );
}

export function SystemWorkspace({
  token,
  organizationId,
  login,
}: {
  token: string;
  organizationId: string;
  login: () => Promise<void>;
}) {
  const [readiness, setReadiness] = useState<AdminReadiness | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!token || !organizationId) return;
    setError("");
    try {
      setReadiness(
        await request<AdminReadiness>(
          `/admin/organizations/${organizationId}/readiness`,
          token,
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "系统状态加载失败");
    }
  }, [organizationId, token]);
  useEffect(() => void load(), [load]);
  if (!token || !organizationId) return <Gate title="系统设置" login={login} />;
  return (
    <section className="catalog-workspace resource-workspace">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">SYSTEM READINESS</span>
          <h2>系统设置与上线门禁</h2>
          <p>这里只读展示开关状态，不读取或输出任何密钥。</p>
        </div>
        <Settings size={28} />
      </div>
      {error && <div className="catalog-error">{error}</div>}
      {readiness && (
        <div className="readiness-grid">
          <article className="panel">
            <h3>身份与后台</h3>
            <p>
              认证渠道 <b>{readiness.auth.provider}</b>
            </p>
            <p>
              工作人员 MFA <GateState value={readiness.auth.staffMfaRequired} />
            </p>
            <p>
              浏览器交接登录{" "}
              <GateState value={readiness.auth.browserLoginEnabled} />
            </p>
          </article>
          <article className="panel">
            <h3>资金</h3>
            <p>
              支付渠道 <b>{readiness.payment.provider}</b>
            </p>
            <p>
              真实预下单 <GateState value={readiness.payment.prepayEnabled} />
            </p>
            <p>
              自动查单恢复{" "}
              <GateState value={readiness.payment.recoveryEnabled} />
            </p>
            <p>
              真实退款提交 <GateState value={readiness.payment.refundEnabled} />
            </p>
          </article>
          <article className="panel">
            <h3>地图与服务区</h3>
            <p>
              地图渠道 <b>{readiness.map.provider}</b>
            </p>
            <p>
              地址核验 <GateState value={readiness.map.geocodingEnabled} />
            </p>
            <p>
              郑州全域代码{" "}
              <GateState value={readiness.map.coverageConfigured} />
            </p>
          </article>
          <article className="panel">
            <h3>安全通知</h3>
            <p>
              短信渠道 <b>{readiness.safety.smsProvider}</b>
            </p>
            <p>
              短信发送 <GateState value={readiness.safety.smsSendEnabled} />
            </p>
            <p>
              自动通知 <GateState value={readiness.safety.dispatchEnabled} />
            </p>
            <p>
              送达查询{" "}
              <GateState value={readiness.safety.receiptQueryEnabled} />
            </p>
            <p>
              真人值班确认 <GateState value={readiness.safety.dutyConfirmed} />
            </p>
          </article>
          <article className="panel">
            <h3>企业微信客服</h3>
            <p>
              提供方 <b>{readiness.customerService.provider}</b>
            </p>
            <p>
              归属与绑定确认{" "}
              <GateState value={readiness.customerService.ownershipConfirmed} />
            </p>
          </article>
        </div>
      )}
      <div className="catalog-gate">
        <ShieldCheck size={20} />
        <div>
          <strong>生产门禁保持失败即关闭</strong>
          <p>
            本地页面可运行不代表真实支付、短信、地图、值班或正式登录已经上线。
          </p>
        </div>
      </div>
    </section>
  );
}
