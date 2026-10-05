import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AuthUser,
  SafetyDutyRosterView,
  SafetyDutyStaffView,
  SafetyIncidentClose,
  SafetyIncidentView,
  SafetyNotificationView,
} from "@zydj/contracts";

const base = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
const statusLabels: Record<string, string> = {
  OPEN: "等待主岗确认",
  ESCALATED: "主岗超时，已升级备岗",
  ACKNOWLEDGED: "值班人员已确认",
  CLOSED: "已关闭",
};
const categoryLabels: Record<string, string> = {
  PERSONAL_SAFETY: "人身安全风险",
  MEDICAL_CONCERN: "身体不适或医疗顾虑",
  SERVICE_DISPUTE: "服务争议需立即介入",
  OTHER_URGENT: "其他紧急情况",
};
const resolutionLabels: Record<SafetyIncidentClose["resolutionCode"], string> =
  {
    RESOLVED: "已妥善处理",
    REFERRED_PUBLIC_EMERGENCY: "已转公共应急服务",
    FALSE_ALARM: "核实为误触/误报",
    FOLLOW_UP_REQUIRED: "仍需后续跟进",
  };

export function SafetyWorkspace({
  token,
  login,
}: {
  token: string;
  login: (code: string) => Promise<void>;
}) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [userToken, setUserToken] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [staff, setStaff] = useState<SafetyDutyStaffView[]>([]);
  const [roster, setRoster] = useState<SafetyDutyRosterView | null>(null);
  const [incidents, setIncidents] = useState<SafetyIncidentView[]>([]);
  const [notifications, setNotifications] = useState<SafetyNotificationView[]>(
    [],
  );
  const [contactPhones, setContactPhones] = useState<Record<string, string>>(
    {},
  );
  const [primaryUserId, setPrimaryUserId] = useState("");
  const [backupUserId, setBackupUserId] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(120);
  const [resolutionCode, setResolutionCode] =
    useState<SafetyIncidentClose["resolutionCode"]>("RESOLVED");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const request = useCallback(
    async <T,>(path: string, body?: object): Promise<T> => {
      const response = await fetch(`${base}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(result.message || `请求失败（${response.status}）`);
      return result.data as T;
    },
    [token],
  );

  useEffect(() => {
    let current = true;
    setUser(null);
    setUserToken("");
    setOrganizationId("");
    setRoster(null);
    setIncidents([]);
    setNotifications([]);
    setStaff([]);
    setError("");
    if (token)
      void request<AuthUser>("/auth/me")
        .then((result) => {
          if (!current) return;
          setUser(result);
          setUserToken(token);
          setOrganizationId(
            result.memberships.find((membership) =>
              ["ADMIN", "SAFETY_DUTY"].includes(membership.role),
            )?.organizationId ?? "",
          );
        })
        .catch((caught) => {
          if (current)
            setError(caught instanceof Error ? caught.message : "身份读取失败");
        });
    return () => {
      current = false;
    };
  }, [request, token]);

  const roles = useMemo(
    () =>
      (userToken === token ? user?.memberships : undefined)
        ?.filter((membership) => membership.organizationId === organizationId)
        .map((membership) => membership.role) ?? [],
    [organizationId, token, user, userToken],
  );
  const canConfigure = roles.includes("ADMIN");

  const load = useCallback(async () => {
    if (!token || !organizationId) return;
    setError("");
    try {
      const [nextRoster, nextIncidents, nextStaff, nextNotifications] =
        await Promise.all([
          request<SafetyDutyRosterView | null>(
            `/admin/organizations/${organizationId}/safety-duty-rosters/current`,
          ),
          request<SafetyIncidentView[]>(
            `/admin/organizations/${organizationId}/safety-incidents`,
          ),
          canConfigure
            ? request<SafetyDutyStaffView[]>(
                `/admin/organizations/${organizationId}/safety-duty-staff`,
              )
            : Promise.resolve([]),
          request<SafetyNotificationView[]>(
            `/admin/organizations/${organizationId}/safety-notifications`,
          ),
        ]);
      setRoster(nextRoster);
      setIncidents(nextIncidents);
      setStaff(nextStaff);
      setNotifications(nextNotifications);
      if (nextRoster) {
        setPrimaryUserId(nextRoster.primaryUserId);
        setBackupUserId(nextRoster.backupUserId);
        setTimeoutSeconds(nextRoster.acknowledgementTimeoutSeconds);
      } else if (nextStaff.length >= 2) {
        setPrimaryUserId((current) => current || nextStaff[0]!.userId);
        setBackupUserId((current) => current || nextStaff[1]!.userId);
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "安全值班数据读取失败",
      );
    }
  }, [canConfigure, organizationId, request, token]);

  useEffect(() => {
    void load();
    if (!token || !organizationId) return;
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load, organizationId, token]);

  async function perform(key: string, action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败");
    } finally {
      setBusy("");
    }
  }

  async function loginAs(code: string) {
    if (busy) return;
    setBusy("login");
    setError("");
    try {
      await login(code);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败");
    } finally {
      setBusy("");
    }
  }

  const staffNames = Object.fromEntries(
    staff.map((member) => [member.userId, member.displayName]),
  );
  const primaryLabel = canConfigure
    ? (staffNames[roster?.primaryUserId ?? ""] ?? "已配置")
    : roster?.primaryUserId === user?.id
      ? "当前账号（主岗）"
      : "已配置";
  const backupLabel = canConfigure
    ? (staffNames[roster?.backupUserId ?? ""] ?? "已配置")
    : roster?.backupUserId === user?.id
      ? "当前账号（备岗）"
      : "已配置";
  const organizationIds = [
    ...new Set(
      user?.memberships
        .filter((membership) =>
          ["ADMIN", "SAFETY_DUTY"].includes(membership.role),
        )
        .map((membership) => membership.organizationId) ?? [],
    ),
  ];

  return (
    <section className="catalog-workspace safety-workspace">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">SAFETY DUTY</span>
          <h2>安全值班与升级队列</h2>
          <p>截止前仅主岗确认，超时后仅备岗确认；只有实际确认人可以关闭。</p>
        </div>
        <button disabled={!!busy} onClick={() => void load()}>
          刷新队列
        </button>
      </div>

      <div className="notice safety-notice">
        <span>重要</span>
        <p>
          数据库事件和 Outbox
          不等于通知送达。自动短信默认关闭，只有受控开关、真实值班号码与渠道验收全部通过后才投递；值班人员仍须保持人工渠道在线。
        </p>
      </div>

      {import.meta.env.DEV && (
        <div className="catalog-actions">
          <button
            disabled={!!busy}
            onClick={() => void loginAs("local-safety-admin")}
          >
            本地安全管理员
          </button>
          <button
            disabled={!!busy}
            onClick={() => void loginAs("local-safety-primary")}
          >
            本地主岗
          </button>
          <button
            disabled={!!busy}
            onClick={() => void loginAs("local-safety-backup")}
          >
            本地备岗
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="catalog-error">
          {error}
        </div>
      )}

      {!token && (
        <div className="catalog-gate">请先使用受控工作人员身份登录。</div>
      )}
      {user && organizationIds.length === 0 && (
        <div className="catalog-gate">当前身份没有安全值班或管理员权限。</div>
      )}
      {organizationIds.length > 0 && (
        <label>
          组织
          <select
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
          >
            {organizationIds.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
        </label>
      )}

      {canConfigure && (
        <article className="panel safety-roster-card">
          <h3>配置主备岗</h3>
          <p>候选人只来自本组织状态有效的安全值班成员。</p>
          {staff.length < 2 ? (
            <div className="catalog-error">
              至少需要两名不同的有效安全值班成员。
            </div>
          ) : (
            <div className="safety-roster-form">
              <label>
                主岗
                <select
                  value={primaryUserId}
                  onChange={(event) => setPrimaryUserId(event.target.value)}
                >
                  {staff.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                备岗
                <select
                  value={backupUserId}
                  onChange={(event) => setBackupUserId(event.target.value)}
                >
                  {staff.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                主岗确认期限
                <select
                  value={timeoutSeconds}
                  onChange={(event) =>
                    setTimeoutSeconds(Number(event.target.value))
                  }
                >
                  {[60, 120, 180, 300, 600, 900].map((seconds) => (
                    <option key={seconds} value={seconds}>
                      {seconds} 秒
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={
                  !!busy || !primaryUserId || primaryUserId === backupUserId
                }
                onClick={() =>
                  void perform("roster", () =>
                    request(
                      `/admin/organizations/${organizationId}/safety-duty-rosters`,
                      {
                        primaryUserId,
                        backupUserId,
                        acknowledgementTimeoutSeconds: timeoutSeconds,
                      },
                    ),
                  )
                }
              >
                保存并停用旧值班表
              </button>
            </div>
          )}
        </article>
      )}

      {canConfigure && staff.length > 0 && (
        <article className="panel safety-contact-card">
          <h3>值班通知号码</h3>
          <p>
            号码只会加密保存，页面不回显原号码；更新后仍需受控短信验收才能开启自动投递。
          </p>
          <div className="safety-contact-list">
            {staff.map((member) => (
              <div className="safety-contact-row" key={member.userId}>
                <span>
                  {member.displayName} ·{" "}
                  {member.phoneConfigured ? "已配置" : "未配置"}
                </span>
                <input
                  aria-label={`${member.displayName}值班手机号`}
                  inputMode="numeric"
                  maxLength={11}
                  placeholder="输入新的 11 位手机号"
                  type="password"
                  value={contactPhones[member.userId] ?? ""}
                  onChange={(event) =>
                    setContactPhones((current) => ({
                      ...current,
                      [member.userId]: event.target.value.replace(/\D/g, ""),
                    }))
                  }
                />
                <button
                  disabled={
                    !!busy ||
                    !/^1[3-9]\d{9}$/.test(contactPhones[member.userId] ?? "")
                  }
                  onClick={() =>
                    void perform(`contact-${member.userId}`, async () => {
                      await request(
                        `/admin/organizations/${organizationId}/safety-duty-staff/${member.userId}/contact`,
                        { phone: contactPhones[member.userId] },
                      );
                      setContactPhones((current) => ({
                        ...current,
                        [member.userId]: "",
                      }));
                    })
                  }
                >
                  加密保存
                </button>
              </div>
            ))}
          </div>
        </article>
      )}

      {roster && (
        <article className="panel safety-roster-summary">
          <h3>当前活动值班表</h3>
          <p>主岗：{primaryLabel}</p>
          <p>备岗：{backupLabel}</p>
          <p>确认期限：{roster.acknowledgementTimeoutSeconds} 秒</p>
        </article>
      )}

      <div className="safety-queue">
        {incidents.map((incident) => {
          const canAcknowledge =
            (incident.status === "OPEN" &&
              incident.primaryUserId === user?.id) ||
            (incident.status === "ESCALATED" &&
              incident.backupUserId === user?.id);
          const canClose =
            incident.status === "ACKNOWLEDGED" &&
            incident.acknowledgedById === user?.id;
          return (
            <article
              className={`panel safety-incident ${incident.status.toLowerCase()}`}
              key={incident.id}
            >
              <div>
                <span className="eyebrow">
                  {categoryLabels[incident.category]}
                </span>
                <h3>{statusLabels[incident.status]}</h3>
                <p>
                  事件 {incident.id} · 订单 {incident.orderId}
                </p>
                <p>
                  主岗截止：
                  {new Date(incident.acknowledgementDueAt).toLocaleString(
                    "zh-CN",
                  )}
                </p>
              </div>
              <div className="safety-incident-actions">
                {canAcknowledge && (
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      void perform(`ack-${incident.id}`, () =>
                        request(
                          `/admin/organizations/${organizationId}/safety-incidents/${incident.id}/acknowledge`,
                          {},
                        ),
                      )
                    }
                  >
                    由本人确认接手
                  </button>
                )}
                {canClose && (
                  <>
                    <select
                      value={resolutionCode}
                      onChange={(event) =>
                        setResolutionCode(
                          event.target
                            .value as SafetyIncidentClose["resolutionCode"],
                        )
                      }
                    >
                      {Object.entries(resolutionLabels).map(([code, label]) => (
                        <option key={code} value={code}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        void perform(`close-${incident.id}`, () =>
                          request(
                            `/admin/organizations/${organizationId}/safety-incidents/${incident.id}/close`,
                            { resolutionCode },
                          ),
                        )
                      }
                    >
                      记录结论并关闭
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
        {!incidents.length && token && organizationId && (
          <div className="catalog-empty">当前没有安全事件。</div>
        )}
      </div>

      {token && organizationId && (
        <article className="panel safety-notification-panel">
          <h3>通知 Outbox</h3>
          <p>
            “渠道已接受”不代表手机已收到；未知结果进入人工复核，系统不会盲目重复发送。
          </p>
          <div className="safety-notification-list">
            {notifications.map((notification) => (
              <div className="safety-notification-row" key={notification.id}>
                <div>
                  <strong>
                    {notification.type === "SAFETY_INCIDENT_OPENED"
                      ? "主岗首报"
                      : "备岗升级"}
                  </strong>
                  <span>
                    {notification.state === "ACCEPTED"
                      ? "渠道已接受"
                      : notification.state === "DEAD_LETTER"
                        ? "需人工复核"
                        : "等待投递"}
                  </span>
                  <small>
                    尝试 {notification.attempts} 次
                    {notification.lastErrorCode
                      ? ` · ${notification.lastErrorCode}`
                      : ""}
                  </small>
                </div>
                {canConfigure && notification.state === "DEAD_LETTER" && (
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      void perform(`retry-${notification.id}`, () =>
                        request(
                          `/admin/organizations/${organizationId}/safety-notifications/${notification.id}/retry`,
                          {},
                        ),
                      )
                    }
                  >
                    人工复核后重试
                  </button>
                )}
              </div>
            ))}
            {!notifications.length && (
              <div className="catalog-empty">当前没有安全通知记录。</div>
            )}
          </div>
        </article>
      )}
    </section>
  );
}
