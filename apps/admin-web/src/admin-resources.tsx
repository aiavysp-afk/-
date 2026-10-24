import { authenticatedFetch } from "./authenticated-fetch";
import { ApplicationEditor } from "./application-editor";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  CalendarDays,
  CircleAlert,
  CircleCheck,
  FileClock,
  IdCard,
  LockKeyhole,
  MapPinned,
  RefreshCw,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import type {
  AdminReadiness,
  AdminTechnicianApplicationUpdate,
  AdminServiceArea,
  AdminShift,
  AdminTechnicianBoard,
  AdminTechnicianReview,
  AuditLogEntry,
  TechnicianInvitation,
  TechnicianInvitationCreated,
  TechnicianProfile,
  TechnicianProfileUpdate,
  TechnicianPhotoUploadResult,
  ServiceItem,
} from "@zydj/contracts";
import {
  adminTechnicianProfilePaths,
  draftWithUploadedPhoto,
  profileStatusLabels,
  profileHasUnsavedChanges,
  profileUpdateFrom,
  reviewStatusLabels,
  splitProfileList,
  submitLatestProfile,
} from "./technician-profile";
import {
  loadTechnicianPhotoPreview,
  prepareTechnicianPhoto,
} from "./technician-photo";
import { createLatestRequest, useBackgroundRefresh } from "./synchronization";
import {
  buildSchedulingShift,
  createSchedulingRequests,
  runSchedulingOperation,
  validSchedulingDate,
  type SchedulingScope,
} from "./scheduling-workspace-state";
import {
  beginScopedWorkspaceRequest,
  createWorkspaceContext,
  emptyTechnicianWorkspace,
  technicianWorkspaceReducer,
} from "./technician-workspace-state";
import {
  displayedTechnicianReviewVersion,
  technicianReviewSnapshotMatches,
} from "./technician-review-snapshot";
import {
  formatAvailabilityTimeSlot,
  hasIdentityDocument,
  loadPrivateIdentityDocumentPreview,
  maskRealName,
  onboardingServiceLabels,
  type IdentityDocumentKind,
  type TechnicianOnboardingReviewProfile,
} from "./technician-onboarding-admin";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";

async function request<T>(
  path: string,
  token: string,
  body?: object,
  method: "POST" | "PATCH" = "POST",
) {
  const response = await authenticatedFetch(token, `${API_BASE_URL}${path}`, {
    method: body ? method : "GET",
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
          <p>登录后读取当前组织的实际数据。</p>
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
  const scope = `${organizationId}:${token}`;
  const context = useMemo(createWorkspaceContext, []);
  const requestContext = context.update(scope);
  const readBusy = useRef(false);
  const invitationOperationBusy = useRef(false);
  const [workspace, dispatchWorkspace] = useReducer(
    technicianWorkspaceReducer,
    scope,
    emptyTechnicianWorkspace,
  );
  // Hide the previous context immediately, before its cleanup effect runs.
  const { board, invitations, applications, loaded } =
    workspace.scope === scope ? workspace : emptyTechnicianWorkspace(scope);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedTechnicianId, setSelectedTechnicianId] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [createdInviteRecord, setCreatedInviteRecord] = useState<{
    context: string;
    value: TechnicianInvitationCreated;
  } | null>(null);
  const createdInvite =
    createdInviteRecord?.context === requestContext
      ? createdInviteRecord.value
      : null;
  const requests = useMemo(createLatestRequest, []);
  const load = useCallback(async () => {
    if (
      !token ||
      !organizationId ||
      readBusy.current ||
      invitationOperationBusy.current
    )
      return false;
    readBusy.current = true;
    const isCurrent = beginScopedWorkspaceRequest(
      requests,
      requestContext,
      () => context.current(),
    );
    setLoading(true);
    setError("");
    try {
      const [boardValue, invitationRows, applicationRows] = await Promise.all([
        request<AdminTechnicianBoard>(
          `/admin/organizations/${organizationId}/technicians`,
          token,
        ),
        request<TechnicianInvitation[]>(
          `/admin/organizations/${organizationId}/technician-invitations`,
          token,
        ),
        request<TechnicianOnboardingReviewProfile[]>(
          `/admin/organizations/${organizationId}/technician-applications`,
          token,
        ),
      ]);
      if (!isCurrent()) return false;
      dispatchWorkspace({
        type: "loaded",
        scope,
        board: boardValue,
        invitations: invitationRows,
        applications: applicationRows,
      });
      return true;
    } catch (caught) {
      if (!isCurrent()) return false;
      dispatchWorkspace({ type: "failed", scope });
      setSelectedTechnicianId("");
      setCreatedInviteRecord(null);
      setError(caught instanceof Error ? caught.message : "技师列表加载失败");
      return false;
    } finally {
      if (isCurrent()) {
        readBusy.current = false;
        setLoading(false);
      }
    }
  }, [organizationId, token, scope, requestContext, context, requests]);
  useEffect(() => {
    dispatchWorkspace({ type: "reset", scope });
    setSelectedTechnicianId("");
    setCreatedInviteRecord(null);
    setInviteName("");
    readBusy.current = false;
    setLoading(false);
    invitationOperationBusy.current = false;
    setInviteBusy(false);
    void load();
  }, [load, scope]);
  useEffect(() => () => requests.invalidate(), [requests]);
  useBackgroundRefresh(
    () => void load(),
    Boolean(token && organizationId && !loading && !inviteBusy),
  );

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

  async function createInvitation() {
    const publicName = inviteName.trim();
    if (readBusy.current || loading || invitationOperationBusy.current) return;
    if (publicName.length > 0 && publicName.length < 2) {
      setError("公开称呼可留空，填写时需2至40字");
      return;
    }
    invitationOperationBusy.current = true;
    const isCurrent = beginScopedWorkspaceRequest(
      requests,
      requestContext,
      () => context.current(),
    );
    setInviteBusy(true);
    setError("");
    try {
      const result = await request<TechnicianInvitationCreated>(
        `/admin/organizations/${organizationId}/technician-invitations`,
        token,
        { publicName, expiresInHours: 72 },
      );
      if (!isCurrent()) return;
      setCreatedInviteRecord({ context: requestContext, value: result });
      setInviteName("");
      dispatchWorkspace({
        type: "invitation-created",
        scope,
        invitation: result.invitation,
      });
    } catch (caught) {
      if (isCurrent())
        setError(caught instanceof Error ? caught.message : "技师邀请创建失败");
    } finally {
      if (isCurrent()) {
        invitationOperationBusy.current = false;
        setInviteBusy(false);
      }
    }
  }

  async function revokeInvitation(invitation: TechnicianInvitation) {
    if (readBusy.current || loading || invitationOperationBusy.current) return;
    if (!window.confirm(`确认撤销“${invitation.publicName}”的一次性邀请？`)) {
      return;
    }
    invitationOperationBusy.current = true;
    const isCurrent = beginScopedWorkspaceRequest(
      requests,
      requestContext,
      () => context.current(),
    );
    setInviteBusy(true);
    setError("");
    try {
      const updated = await request<TechnicianInvitation>(
        `/admin/organizations/${organizationId}/technician-invitations/${invitation.id}/revoke`,
        token,
        {},
      );
      if (!isCurrent()) return;
      dispatchWorkspace({
        type: "invitation-updated",
        scope,
        invitation: updated,
      });
      if (createdInvite?.invitation.id === updated.id)
        setCreatedInviteRecord(null);
    } catch (caught) {
      if (isCurrent())
        setError(caught instanceof Error ? caught.message : "技师邀请撤销失败");
    } finally {
      if (isCurrent()) {
        invitationOperationBusy.current = false;
        setInviteBusy(false);
      }
    }
  }

  async function copyInvitation(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      window.alert(`${label}已复制`);
    } catch {
      setError(`无法自动复制，请手动复制：${value}`);
    }
  }

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
          disabled={loading || inviteBusy}
          onClick={() => void load()}
        >
          <RefreshCw size={15} className={loading ? "spinning" : ""} />
          刷新
        </button>
      </div>
      {error && (
        <div className="catalog-error" role="alert">
          <span>{error}</span>
          {!loaded && (
            <p>
              申请队列尚未成功读取，不能据此认定没有申请。已关闭旧审核资料；请检查登录、组织权限和安全验证后重试。
            </p>
          )}
          <button
            className="ghost-action"
            disabled={loading || inviteBusy}
            onClick={() => void load()}
          >
            重新读取技师资料
          </button>
        </div>
      )}
      <section className="technician-invite-card">
        <div className="technician-invite-copy">
          <h3>微信自主入驻审核</h3>
          <p>
            本人微信和手机号验证后直接提交资料，无需邀请码。列表只显示脱敏姓名；审核详情内才可核验实名和私密证件。
          </p>
        </div>
        <div className="technician-invite-list">
          {applications.map((application) => {
            const applicantName =
              application.publicName ||
              maskRealName(application.realName) ||
              "姓名待补录的入驻申请";
            return (
              <div key={application.technicianId}>
                <span>
                  <strong>{applicantName}</strong>
                  <small>
                    {profileStatusLabels[application.status]} ·{" "}
                    {formatDateTime(application.updatedAt)}
                  </small>
                  <small>
                    {application.serviceCity || "服务城市待填"} ·{" "}
                    {application.serviceAreas?.length
                      ? `${application.serviceAreas.length} 个接单区域`
                      : "接单区域待填"}
                  </small>
                </span>
                <em data-status={application.status}>
                  {profileStatusLabels[application.status]}
                </em>
                <button
                  className="ghost-action"
                  onClick={() =>
                    setSelectedTechnicianId(application.technicianId)
                  }
                >
                  查看资料 / 审核
                </button>
              </div>
            );
          })}
          {!loaded && !error && <p role="status">正在读取入驻申请…</p>}
          {loaded && !loading && !error && !applications.length && (
            <p>暂无自主入驻申请。</p>
          )}
        </div>
      </section>
      <section className="technician-invite-card">
        <div className="technician-invite-copy">
          <span className="eyebrow">ONE-TIME ONBOARDING</span>
          <h3>真实技师入驻邀请</h3>
          <p>
            邀请码72小时内仅可由一个已完成微信及手机号验证的本人账号认领；认领后资料保持草稿，仍需填报、审核和发布。
          </p>
        </div>
        <div className="technician-invite-create">
          <input
            maxLength={40}
            value={inviteName}
            placeholder="公开称呼可留空，后续补录"
            onChange={(event) => setInviteName(event.target.value)}
          />
          <button
            className="primary-action"
            disabled={inviteBusy || loading}
            onClick={() => void createInvitation()}
          >
            {inviteBusy ? "处理中…" : "生成一次性邀请"}
          </button>
        </div>
        {createdInvite && (
          <div className="technician-invite-secret">
            <div>
              <small>仅本次显示，请交给技师本人</small>
              <code>{createdInvite.code}</code>
              <span>{createdInvite.miniappPath}</span>
            </div>
            <button
              className="ghost-action"
              onClick={() => void copyInvitation(createdInvite.code, "邀请码")}
            >
              复制邀请码
            </button>
            <button
              className="ghost-action"
              onClick={() =>
                void copyInvitation(createdInvite.miniappPath, "小程序路径")
              }
            >
              复制小程序路径
            </button>
          </div>
        )}
        <div className="technician-invite-list">
          {invitations.slice(0, 12).map((invitation) => (
            <div key={invitation.id}>
              <span>
                <strong>
                  {invitation.publicName || "姓名待补录的技师邀请"}
                </strong>
                <small>
                  {invitation.status === "CLAIMED"
                    ? `已由 ${invitation.claimedDisplayName ?? "已验证账号"} 认领`
                    : `有效期至 ${formatDateTime(invitation.expiresAt)}`}
                </small>
              </span>
              <em data-status={invitation.status}>
                {
                  {
                    PENDING: "待认领",
                    CLAIMED: "已认领",
                    REVOKED: "已撤销",
                    EXPIRED: "已过期",
                  }[invitation.status]
                }
              </em>
              {invitation.status === "PENDING" && (
                <button
                  className="ghost-action"
                  disabled={inviteBusy}
                  onClick={() => void revokeInvitation(invitation)}
                >
                  撤销
                </button>
              )}
            </div>
          ))}
          {loaded && !loading && !error && invitations.length === 0 && (
            <p>尚未生成真实技师邀请。</p>
          )}
        </div>
      </section>
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
            <button
              className="profile-detail-button"
              onClick={() => setSelectedTechnicianId(technician.id)}
            >
              查看与维护公开资料
            </button>
          </article>
        ))}
      </div>
      {loaded && !loading && !error && rows.length === 0 && (
        <div className="catalog-empty">
          {needle ? "没有匹配的技师" : "当前组织暂无已启用技师"}
        </div>
      )}
      {loaded && selectedTechnicianId && (
        <AdminTechnicianProfilePanel
          key={`${organizationId}:${selectedTechnicianId}:${token}`}
          token={token}
          organizationId={organizationId}
          technicianId={selectedTechnicianId}
          application={applications.find(
            (item) => item.technicianId === selectedTechnicianId,
          )}
          onReloadApplication={load}
          onClose={() => setSelectedTechnicianId("")}
        />
      )}
    </section>
  );
}

function AdminTechnicianProfilePanel({
  token,
  organizationId,
  technicianId,
  application,
  onReloadApplication,
  onClose,
}: {
  token: string;
  organizationId: string;
  technicianId: string;
  application?: TechnicianOnboardingReviewProfile;
  onReloadApplication: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<TechnicianProfile | null>(null);
  const [catalogServices, setCatalogServices] = useState<ServiceItem[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<Record<string, string>>(
    {},
  );
  const [draft, setDraft] = useState<TechnicianProfileUpdate | null>(null);
  const [reviews, setReviews] = useState<AdminTechnicianReview[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviewSavingId, setReviewSavingId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [identityLoadingKind, setIdentityLoadingKind] =
    useState<IdentityDocumentKind | null>(null);
  const [identityPreview, setIdentityPreview] = useState<{
    kind: IdentityDocumentKind;
    url: string;
    snapshot: string;
  } | null>(null);
  const requests = useMemo(createLatestRequest, []);
  const identityRequests = useMemo(createLatestRequest, []);
  const operationBusy = useRef(false);
  const profilePaths = adminTechnicianProfilePaths(
    organizationId,
    technicianId,
  );
  const { profile: profilePath, reviews: reviewsPath } = profilePaths;
  const snapshotMatches = technicianReviewSnapshotMatches(profile, application);
  const applicationSnapshotStale = Boolean(application && !snapshotMatches);
  const identitySnapshot =
    profile && application && snapshotMatches
      ? `${profile.technicianId}:${application.version}`
      : "";
  const currentIdentitySnapshot = useRef(identitySnapshot);
  currentIdentitySnapshot.current = identitySnapshot;

  const load = useCallback(async () => {
    if (operationBusy.current) return;
    const isCurrent = requests.begin();
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const [value, reviewRows, services] = await Promise.all([
        request<TechnicianProfile>(profilePath, token),
        request<AdminTechnicianReview[]>(reviewsPath, token),
        request<ServiceItem[]>("/catalog/services", token).catch(() => []),
      ]);
      if (!isCurrent()) return;
      setProfile(value);
      setDraft(profileUpdateFrom(value));
      setReviews(reviewRows);
      setCatalogServices(services);
    } catch (caught) {
      if (!isCurrent()) return;
      setProfile(null);
      setDraft(null);
      setReviews([]);
      setError(caught instanceof Error ? caught.message : "技师资料读取失败");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [profilePath, reviewsPath, token, requests]);

  useEffect(() => void load(), [load]);
  useEffect(() => () => requests.invalidate(), [requests]);
  useEffect(() => () => identityRequests.invalidate(), [identityRequests]);
  const dirty = Boolean(
    profile && draft && profileHasUnsavedChanges(profile, draft),
  );
  async function reloadDisplayedApplication() {
    if (operationBusy.current || loading || dirty) return;
    const stillOpen = requests.begin();
    if (application && !(await onReloadApplication())) return;
    if (!stillOpen()) return;
    await load();
  }
  useBackgroundRefresh(
    () => void load(),
    !dirty && !saving && !reviewSavingId && !loading,
  );

  useEffect(() => {
    let active = true;
    const blobUrls: string[] = [];
    const urls = [profile?.avatarUrl, ...(profile?.galleryUrls ?? [])].filter(
      (url): url is string => Boolean(url),
    );
    void Promise.all(
      urls.map(async (url) => {
        const preview = await loadTechnicianPhotoPreview(
          url,
          API_BASE_URL,
          profilePath,
          token,
        );
        if (preview.startsWith("blob:")) blobUrls.push(preview);
        return [url, preview] as const;
      }),
    )
      .then((entries) => {
        if (active) setPhotoPreviews(Object.fromEntries(entries));
        else blobUrls.forEach((url) => URL.revokeObjectURL(url));
      })
      .catch(() => {
        blobUrls.forEach((url) => URL.revokeObjectURL(url));
        if (active) setError("照片预览读取失败，请刷新后重试");
      });
    return () => {
      active = false;
      blobUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [profile, profilePath, token]);

  useEffect(() => {
    const previewUrl = identityPreview?.url;
    return () => {
      if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    };
  }, [identityPreview?.url]);

  useEffect(() => {
    identityRequests.invalidate();
    setIdentityPreview(null);
    setIdentityLoadingKind(null);
  }, [identitySnapshot, identityRequests]);

  async function previewIdentityDocument(kind: IdentityDocumentKind) {
    if (!application || !identitySnapshot || identityLoadingKind) return;
    const isCurrent = beginScopedWorkspaceRequest(
      identityRequests,
      identitySnapshot,
      () => currentIdentitySnapshot.current,
    );
    setIdentityLoadingKind(kind);
    setError("");
    try {
      const url = await loadPrivateIdentityDocumentPreview(
        API_BASE_URL,
        organizationId,
        technicianId,
        kind,
        token,
      );
      if (!isCurrent()) {
        URL.revokeObjectURL(url);
        return;
      }
      setIdentityPreview({ kind, url, snapshot: identitySnapshot });
    } catch (caught) {
      if (isCurrent()) {
        setError(caught instanceof Error ? caught.message : "证件预览读取失败");
      }
    } finally {
      if (isCurrent()) setIdentityLoadingKind(null);
    }
  }

  async function uploadPhoto(
    file: File | undefined,
    kind: "AVATAR" | "GALLERY",
  ) {
    if (!file || loading || operationBusy.current) return;
    if (
      !window.confirm(
        "确认已取得该技师本人照片授权？照片会同步统一后台，需单独审核/发布后才向客户展示。不要上传身份证或证件号码。",
      )
    )
      return;
    operationBusy.current = true;
    const isCurrent = requests.begin();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const base64 = await prepareTechnicianPhoto(file);
      const result = await request<TechnicianPhotoUploadResult>(
        `${profilePath}/photos`,
        token,
        { kind, base64, authorized: true },
      );
      if (!isCurrent()) return;
      setProfile(result.profile);
      setDraft((current) =>
        draftWithUploadedPhoto(
          current ?? profileUpdateFrom(result.profile),
          kind,
          result.publicUrl,
        ),
      );
      setMessage(
        "照片已保存并同步技师端；公开状态待审核/发布，姓名和年龄段可留空。",
      );
    } catch (caught) {
      if (isCurrent())
        setError(caught instanceof Error ? caught.message : "照片上传失败");
    } finally {
      operationBusy.current = false;
      if (isCurrent()) setSaving(false);
    }
  }

  async function saveProfile(showConfirmation = true) {
    if (!draft || loading || operationBusy.current) return null;
    operationBusy.current = true;
    const isCurrent = requests.begin();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const value = await request<TechnicianProfile>(
        profilePath,
        token,
        draft,
        "PATCH",
      );
      if (!isCurrent()) return null;
      setProfile(value);
      setDraft(profileUpdateFrom(value));
      if (showConfirmation) setMessage("资料修改已保存并同步到三端数据源。");
      return value;
    } catch (caught) {
      if (isCurrent())
        setError(caught instanceof Error ? caught.message : "技师资料保存失败");
      return null;
    } finally {
      operationBusy.current = false;
      if (isCurrent()) setSaving(false);
    }
  }

  async function saveApplication(value: AdminTechnicianApplicationUpdate) {
    if (loading || operationBusy.current || dirty || applicationSnapshotStale)
      return false;
    operationBusy.current = true;
    const isCurrent = requests.begin();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const updated = await request<TechnicianOnboardingReviewProfile>(
        `/admin/organizations/${encodeURIComponent(organizationId)}/technician-applications/${encodeURIComponent(technicianId)}`,
        token,
        value,
        "PATCH",
      );
      if (!isCurrent()) return false;
      setProfile(updated);
      setDraft(profileUpdateFrom(updated));
      await onReloadApplication();
      if (isCurrent())
        setMessage(
          "入驻资料已补录并同步技师端，请核对照片和证件后重新提交审核。",
        );
      return true;
    } catch (caught) {
      if (isCurrent())
        setError(caught instanceof Error ? caught.message : "补录保存失败");
      return false;
    } finally {
      operationBusy.current = false;
      if (isCurrent()) setSaving(false);
    }
  }

  async function runWorkflowAction(
    action: "submit-review" | "approve" | "reject" | "publish" | "unpublish",
  ) {
    if (!profile || !draft || loading || operationBusy.current) return;
    const reviewAction =
      action === "approve" || action === "publish" || action === "reject";
    if (reviewAction && (dirty || applicationSnapshotStale)) return;
    const expectedVersion = displayedTechnicianReviewVersion(
      profile,
      application,
    );
    const labels = {
      "submit-review":
        "确认保存当前最新照片和真实资料，并提交后台审核？姓名、年龄段可后补。",
      approve: "确认资料内容与真人授权、资质核验结果一致并通过审核？",
      reject: "确认退回本次申请，由技师本人修改资料后重新提交？",
      publish: "确认将这份资料公开给客户端客户查看？",
      unpublish: "确认暂停公开这份技师资料？",
    } as const;
    const reason =
      action === "reject"
        ? window.prompt("请填写2至500字退回原因")?.trim()
        : undefined;
    if (
      action === "reject" &&
      (!reason || reason.length < 2 || reason.length > 500)
    )
      return;
    if (!window.confirm(labels[action])) return;
    operationBusy.current = true;
    const isCurrent = requests.begin();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const value =
        action === "submit-review"
          ? await submitLatestProfile(
              draft,
              async (latestDraft) => {
                const saved = await request<TechnicianProfile>(
                  profilePath,
                  token,
                  latestDraft,
                  "PATCH",
                );
                if (isCurrent()) {
                  setProfile(saved);
                  setDraft(profileUpdateFrom(saved));
                }
                return saved;
              },
              () =>
                request<TechnicianProfile>(
                  profilePaths.profileAction(action),
                  token,
                  {},
                ),
              isCurrent,
            )
          : await request<TechnicianProfile>(
              profilePaths.profileAction(action),
              token,
              action === "reject"
                ? { reason, expectedVersion }
                : action === "approve"
                  ? { expectedVersion }
                  : {},
            );
      if (!value || !isCurrent()) return;
      setProfile(value);
      setDraft(profileUpdateFrom(value));
      setMessage(
        action === "submit-review"
          ? "最新资料已提交审核，审核通过并单独发布后才会对客户公开。"
          : action === "approve"
            ? "审核已通过，仍需单独发布才会对客户公开。"
            : action === "reject"
              ? "申请已退回，原因已同步技师端，未授予接单资格。"
              : action === "publish"
                ? "资料已公开，客户端将读取同一份资料。"
                : "资料已停止公开，历史订单和评价未删除。",
      );
      if (application) await onReloadApplication();
    } catch (caught) {
      if (isCurrent())
        setError(caught instanceof Error ? caught.message : "资料状态更新失败");
    } finally {
      operationBusy.current = false;
      if (isCurrent()) setSaving(false);
    }
  }

  async function moderateReview(
    review: AdminTechnicianReview,
    action: "publish" | "hide",
  ) {
    if (loading || operationBusy.current) return;
    const confirmation =
      action === "publish"
        ? "确认该客户评价符合平台用户内容规范并公开展示？"
        : "确认隐藏该客户评价？订单和原始评价记录仍会保留。";
    if (!window.confirm(confirmation)) return;
    operationBusy.current = true;
    const isCurrent = requests.begin();
    setReviewSavingId(review.id);
    setError("");
    setMessage("");
    try {
      const updated = await request<AdminTechnicianReview>(
        profilePaths.reviewAction(review.id, action),
        token,
        {},
      );
      if (!isCurrent()) return;
      setReviews((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      const latestProfile = await request<TechnicianProfile>(
        profilePath,
        token,
      );
      if (!isCurrent()) return;
      setProfile(latestProfile);
      setMessage(
        action === "publish"
          ? "评价已通过 UGC 审核并公开展示。"
          : "评价已隐藏，原始内容和关联订单仍保留。",
      );
    } catch (caught) {
      if (isCurrent())
        setError(caught instanceof Error ? caught.message : "评价审核失败");
    } finally {
      operationBusy.current = false;
      if (isCurrent()) setReviewSavingId("");
    }
  }

  return (
    <section className="panel technician-profile-panel">
      <div className="technician-profile-head">
        <div>
          <span className="eyebrow">UNIFIED PUBLIC PROFILE</span>
          <h2>技师公开资料审核</h2>
          <p>
            技师端填报、管理后台审核、客户端展示共用同一数据源；评价来自完成订单，只读不可改。
          </p>
        </div>
        <div className="technician-profile-head-actions">
          <button
            className="ghost-action"
            disabled={loading || saving || Boolean(reviewSavingId) || dirty}
            onClick={() => void reloadDisplayedApplication()}
          >
            <RefreshCw size={15} className={loading ? "spinning" : ""} />
            刷新
          </button>
          <button className="ghost-action" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
      {loading && <div className="catalog-empty">正在读取技师资料…</div>}
      {error && <div className="catalog-error">{error}</div>}
      {message && <div className="profile-admin-success">{message}</div>}
      {applicationSnapshotStale && profile && (
        <div className="catalog-error" role="alert">
          <p>
            私密入驻资料与当前技师资料版本不一致，已暂停审核通过、退回和发布，并清除旧证件预览。请重新读取申请，再核验当前版本。
          </p>
          <button
            className="ghost-action"
            disabled={loading || saving || Boolean(reviewSavingId) || dirty}
            onClick={() => void reloadDisplayedApplication()}
          >
            重新读取入驻申请
          </button>
        </div>
      )}
      {profile && draft && !loading && (
        <>
          <div className="profile-admin-summary">
            {profile.avatarUrl ? (
              <img
                src={photoPreviews[profile.avatarUrl] || profile.avatarUrl}
                alt="本人授权的技师照片"
              />
            ) : (
              <div className="resource-icon">
                <UserRound size={22} />
              </div>
            )}
            <div>
              <strong>{profile.publicName || profile.displayName}</strong>
              <small>账号名称：{profile.displayName}</small>
              <span>
                所有技师免出行费 · ¥{(profile.travelFeeFen / 100).toFixed(2)}
              </span>
            </div>
            <em
              className={`profile-admin-status status-${profile.status.toLowerCase()}`}
            >
              {profileStatusLabels[profile.status]}
            </em>
          </div>
          {profile.rejectionReason && (
            <div className="catalog-error">
              最近退回原因：{profile.rejectionReason}
            </div>
          )}
          {application && (
            <section className="onboarding-review-card">
              <header>
                <div>
                  <span className="eyebrow">PRIVATE ONBOARDING REVIEW</span>
                  <h3>入驻实名资料</h3>
                  <p>
                    仅当前组织授权审核人员可见；实名和证件不进入客户端公开资料。
                  </p>
                </div>
                <span className="onboarding-channel">
                  {
                    {
                      WECHAT_H5: "微信 H5 入驻",
                      WECHAT_MINIAPP: "微信小程序入驻",
                      TECHNICIAN_PHONE: "技师手机号入驻",
                      LEGACY: "历史资料",
                    }[application.registrationChannel]
                  }
                </span>
              </header>
              <ApplicationEditor
                key={`${application.technicianId}:${application.version}`}
                application={application}
                services={catalogServices}
                disabled={
                  loading ||
                  saving ||
                  dirty ||
                  applicationSnapshotStale ||
                  Boolean(reviewSavingId)
                }
                onSave={saveApplication}
              />
              <dl className="onboarding-review-grid">
                <div>
                  <dt>真实姓名</dt>
                  <dd>{application.realName || "待补录"}</dd>
                  <small>仅用于后台实名审核</small>
                </div>
                <div>
                  <dt>服务城市</dt>
                  <dd>{application.serviceCity || "待补录"}</dd>
                </div>
                <div>
                  <dt>接单区域</dt>
                  <dd>
                    {application.serviceAreas.length
                      ? application.serviceAreas.join("、")
                      : "待补录"}
                  </dd>
                </div>
                <div>
                  <dt>可接单时间段</dt>
                  <dd>
                    {application.availableTimeSlots.length
                      ? application.availableTimeSlots
                          .map(formatAvailabilityTimeSlot)
                          .join("、")
                      : "待补录"}
                  </dd>
                </div>
                <div className="onboarding-review-wide">
                  <dt>擅长项目</dt>
                  <dd className="onboarding-review-tags">
                    {onboardingServiceLabels(
                      application.serviceIds,
                      catalogServices,
                    ).map((name) => (
                      <span key={name}>{name}</span>
                    ))}
                    {!application.serviceIds.length && <span>待补录</span>}
                  </dd>
                </div>
                <div className="onboarding-review-wide">
                  <dt>个人简介</dt>
                  <dd className="onboarding-review-bio">
                    {application.introduction || "待补录"}
                  </dd>
                </div>
              </dl>
              <div className="identity-document-review">
                <div>
                  <LockKeyhole size={18} />
                  <span>
                    <strong>身份证核验</strong>
                    <small>
                      点击后才从私密接口加载，预览不缓存且不生成公开 URL。
                    </small>
                  </span>
                </div>
                <div>
                  {(["ID_FRONT", "ID_BACK"] as const).map((kind) => {
                    const uploaded = hasIdentityDocument(application, kind);
                    return (
                      <button
                        key={kind}
                        type="button"
                        className="ghost-action identity-preview-action"
                        disabled={
                          applicationSnapshotStale ||
                          !uploaded ||
                          Boolean(identityLoadingKind)
                        }
                        onClick={() => void previewIdentityDocument(kind)}
                      >
                        <IdCard size={15} />
                        {!uploaded
                          ? kind === "ID_FRONT"
                            ? "正面未上传"
                            : "反面未上传"
                          : identityLoadingKind === kind
                            ? "读取中…"
                            : kind === "ID_FRONT"
                              ? "私密查看正面"
                              : "私密查看反面"}
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>
          )}
          <div className="profile-admin-layout">
            <fieldset
              className="profile-admin-form"
              disabled={saving || Boolean(reviewSavingId)}
            >
              <label>
                客户端公开称呼（可留空）
                <input
                  maxLength={40}
                  value={draft.publicName ?? ""}
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
                年龄段（可留空，后续补录）
                <select
                  value={draft.ageRange ?? ""}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            ageRange: (event.target.value ||
                              null) as TechnicianProfileUpdate["ageRange"],
                          }
                        : current,
                    )
                  }
                >
                  <option value="">暂不填写/不展示</option>
                  <option value="18-23岁">18-23岁</option>
                  <option value="24-29岁">24-29岁</option>
                  <option value="30-39岁">30-39岁</option>
                  <option value="40岁及以上">40岁及以上</option>
                </select>
              </label>
              <label>
                上传头像照片
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  disabled={saving}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    void uploadPhoto(file, "AVATAR");
                  }}
                />
                <small>
                  自动压缩去定位信息；不上传证件。旧地址录入功能继续保留。
                </small>
              </label>
              <label>
                头像 HTTPS 地址
                <input
                  inputMode="url"
                  value={draft.avatarUrl ?? ""}
                  placeholder="只能使用已取得本人授权的照片"
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? { ...current, avatarUrl: event.target.value || null }
                        : current,
                    )
                  }
                />
              </label>
              <label className="profile-admin-wide">
                真实服务简介
                <textarea
                  rows={5}
                  maxLength={2000}
                  value={draft.introduction ?? ""}
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
                  rows={4}
                  value={(draft.specialties ?? []).join("\n")}
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
              <label className="profile-admin-wide">
                生活照/工作照 HTTPS 地址（每行一张）
                <textarea
                  rows={4}
                  value={(draft.galleryUrls ?? []).join("\n")}
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
              <label className="profile-admin-wide">
                添加详情相册照片（最多12张）
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  disabled={saving || (draft.galleryUrls?.length ?? 0) >= 12}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    void uploadPhoto(file, "GALLERY");
                  }}
                />
                <div className="profile-admin-gallery">
                  {(profile.galleryUrls ?? []).map((url) => (
                    <img
                      key={url}
                      src={photoPreviews[url] || url}
                      alt="本人授权的相册照片"
                      style={{
                        width: 90,
                        height: 120,
                        objectFit: "cover",
                        borderRadius: 10,
                        margin: 5,
                      }}
                    />
                  ))}
                </div>
              </label>
              <label className="profile-admin-wide">
                已核验资质展示名称（每行一项）
                <textarea
                  rows={4}
                  value={(draft.certificates ?? []).join("\n")}
                  placeholder="只填写已核验的资质名称，不填写证件号"
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
                <small>不得录入身份证号、证件号码或未经核验的资质。</small>
              </label>
              <div className="profile-admin-actions profile-admin-wide">
                {dirty && (
                  <p className="profile-admin-dirty">
                    有未保存修改。提交审核会先保存；审核通过或发布前，请保存并重新提交审核。
                  </p>
                )}
                <button
                  className="ghost-action"
                  disabled={saving}
                  onClick={() => void saveProfile()}
                >
                  {saving ? "保存中…" : "保存修改"}
                </button>
                <button
                  className="ghost-action"
                  disabled={
                    saving ||
                    (profile.status !== "DRAFT" &&
                      profile.status !== "REJECTED")
                  }
                  onClick={() => void runWorkflowAction("submit-review")}
                >
                  提交最新资料审核
                </button>
                <button
                  className="primary-action compact"
                  disabled={
                    saving ||
                    dirty ||
                    applicationSnapshotStale ||
                    profile.status !== "PENDING_REVIEW"
                  }
                  onClick={() => void runWorkflowAction("approve")}
                >
                  审核通过
                </button>
                <button
                  className="danger-action"
                  disabled={
                    saving ||
                    dirty ||
                    applicationSnapshotStale ||
                    profile.status !== "PENDING_REVIEW"
                  }
                  onClick={() => void runWorkflowAction("reject")}
                >
                  退回修改
                </button>
                {profile.status === "PUBLISHED" ? (
                  <button
                    className="danger-action"
                    disabled={saving}
                    onClick={() => void runWorkflowAction("unpublish")}
                  >
                    暂停公开
                  </button>
                ) : (
                  <button
                    className="primary-action compact"
                    disabled={
                      saving ||
                      dirty ||
                      applicationSnapshotStale ||
                      profile.status !== "APPROVED"
                    }
                    onClick={() => void runWorkflowAction("publish")}
                  >
                    发布到客户端
                  </button>
                )}
              </div>
            </fieldset>
            <aside className="profile-admin-reviews">
              <div>
                <span>客户评价 · UGC 审核</span>
                <strong>
                  {profile.reviewSummary.averageRating?.toFixed(1) ?? "暂无"}
                </strong>
                <small>
                  {profile.reviewSummary.reviewCount} 条已公开 ·{" "}
                  {profile.reviewSummary.completedOrders} 个已完成订单
                </small>
                <div className="review-status-summary">
                  <span>
                    待审{" "}
                    {
                      reviews.filter(
                        (review) => review.status === "PENDING_REVIEW",
                      ).length
                    }
                  </span>
                  <span>
                    公开{" "}
                    {
                      reviews.filter((review) => review.status === "PUBLISHED")
                        .length
                    }
                  </span>
                  <span>
                    隐藏{" "}
                    {
                      reviews.filter((review) => review.status === "HIDDEN")
                        .length
                    }
                  </span>
                </div>
              </div>
              {reviews.map((review) => (
                <article
                  className={`review-admin-item status-${review.status.toLowerCase()}`}
                  key={review.id}
                >
                  <header>
                    <div>
                      <b>{review.customerAlias}</b>
                      <small>{reviewStatusLabels[review.status]}</small>
                    </div>
                    <span>{"★".repeat(review.rating)}</span>
                  </header>
                  <p>{review.content}</p>
                  <footer>
                    <time>
                      {new Date(review.createdAt).toLocaleDateString("zh-CN")}
                    </time>
                    <div>
                      {review.status !== "PUBLISHED" && (
                        <button
                          className="review-publish-action"
                          disabled={saving || Boolean(reviewSavingId)}
                          onClick={() => void moderateReview(review, "publish")}
                        >
                          {reviewSavingId === review.id
                            ? "处理中…"
                            : review.status === "HIDDEN"
                              ? "重新公开"
                              : "审核并公开"}
                        </button>
                      )}
                      {review.status !== "HIDDEN" && (
                        <button
                          className="review-hide-action"
                          disabled={saving || Boolean(reviewSavingId)}
                          onClick={() => void moderateReview(review, "hide")}
                        >
                          {reviewSavingId === review.id ? "处理中…" : "隐藏"}
                        </button>
                      )}
                    </div>
                  </footer>
                </article>
              ))}
              {reviews.length === 0 && (
                <div className="catalog-empty">暂无客户评价待处理</div>
              )}
              <p className="review-moderation-note">
                评价正文来自已完成订单。管理员只能审核公开或隐藏，不能改写客户内容。
              </p>
            </aside>
          </div>
          {identityPreview && identityPreview.snapshot === identitySnapshot && (
            <div
              className="identity-preview-backdrop"
              role="dialog"
              aria-modal="true"
              aria-label={
                identityPreview.kind === "ID_FRONT"
                  ? "身份证正面私密预览"
                  : "身份证反面私密预览"
              }
              onClick={() => setIdentityPreview(null)}
            >
              <section
                className="identity-preview-dialog"
                onClick={(event) => event.stopPropagation()}
              >
                <header>
                  <div>
                    <span className="eyebrow">PRIVATE DOCUMENT</span>
                    <h3>
                      {identityPreview.kind === "ID_FRONT"
                        ? "身份证正面"
                        : "身份证反面"}
                    </h3>
                  </div>
                  <button
                    type="button"
                    className="ghost-action"
                    onClick={() => setIdentityPreview(null)}
                  >
                    关闭并清除预览
                  </button>
                </header>
                <img src={identityPreview.url} alt="入驻实名证件私密预览" />
                <p>只用于核验本人入驻资料，禁止下载、转发或用于其他用途。</p>
              </section>
            </div>
          )}
        </>
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
  // Identity changes discard every private row and draft before first render.
  return (
    <SchedulingIdentityScope
      key={JSON.stringify([token, organizationId])}
      token={token}
      organizationId={organizationId}
      login={login}
    />
  );
}

function SchedulingIdentityScope({
  token,
  organizationId,
  login,
}: {
  token: string;
  organizationId: string;
  login: () => Promise<void>;
}) {
  const [date, setDate] = useState(nextShanghaiDate());
  const requests = useMemo(createSchedulingRequests, []);
  // Render-time scope selection fences replies before effect cleanup executes.
  const scope = requests.select(token, organizationId, date);
  type ReadState = {
    scope: SchedulingScope;
    phase: "loading" | "ready" | "failed";
    board: AdminTechnicianBoard | null;
    shifts: AdminShift[];
    saving: boolean;
    error: string;
    message: string;
  };
  const emptyRead = (selected: SchedulingScope): ReadState => ({
    scope: selected,
    phase: "loading",
    board: null,
    shifts: [],
    saving: false,
    error: "",
    message: "",
  });
  const [readState, setReadState] = useState<ReadState>(() => emptyRead(scope));
  const current = readState.scope === scope ? readState : emptyRead(scope);
  const [therapistId, setTherapistId] = useState("");
  const [startsAt, setStartsAt] = useState(`${date}T09:00`);
  const [endsAt, setEndsAt] = useState(`${date}T18:00`);
  const pendingSave = useRef<symbol | null>(null);
  const load = useCallback(
    async (message = "") => {
      if (!token || !organizationId) return;
      const isCurrent = requests.begin(scope);
      if (!isCurrent()) return;
      setReadState({ ...emptyRead(scope), message });
      if (!validSchedulingDate(date)) {
        setReadState({
          ...emptyRead(scope),
          phase: "failed",
          error: "请选择有效的排班日期",
        });
        return;
      }
      await runSchedulingOperation({
        isCurrent,
        execute: () =>
          Promise.all([
            request<AdminTechnicianBoard>(
              `/admin/organizations/${encodeURIComponent(organizationId)}/technicians`,
              token,
            ),
            request<AdminShift[]>(
              `/admin/scheduling/shifts?organizationId=${encodeURIComponent(organizationId)}&date=${date}`,
              token,
            ),
          ]),
        success: ([board, shifts]) => {
          setReadState({
            ...emptyRead(scope),
            phase: "ready",
            board,
            shifts,
            message,
          });
          setTherapistId((selected) =>
            board.technicians.some((technician) => technician.id === selected)
              ? selected
              : board.technicians[0]?.id || "",
          );
        },
        failure: (caught) =>
          setReadState({
            ...emptyRead(scope),
            phase: "failed",
            message,
            error: caught instanceof Error ? caught.message : "排班加载失败",
          }),
      });
    },
    [date, organizationId, token, scope, requests],
  );
  useEffect(() => {
    void load();
    return () => requests.invalidate();
  }, [load, requests]);

  if (!token || !organizationId) {
    return <Gate title="排班中心" login={login} />;
  }

  const shiftInput = buildSchedulingShift(
    { date, organizationId, therapistId, startsAt, endsAt },
    {
      ready: current.phase === "ready",
      busy: current.saving,
      technicianIds:
        current.board?.technicians.map((technician) => technician.id) ?? [],
    },
  );
  async function createShift() {
    if (!shiftInput || pendingSave.current) return;
    const isCurrent = requests.begin(scope);
    if (!isCurrent()) return;
    const operation = Symbol("shift-save");
    pendingSave.current = operation;
    setReadState({ ...current, saving: true, error: "", message: "" });
    await runSchedulingOperation({
      isCurrent,
      execute: () => request("/admin/scheduling/shifts", token, shiftInput),
      success: async () => {
        pendingSave.current = null;
        await load("排班已创建并写入审计记录。");
      },
      failure: (caught) =>
        setReadState((state) => ({
          ...state,
          error: caught instanceof Error ? caught.message : "排班创建失败",
        })),
      finish: () => {
        if (pendingSave.current === operation) pendingSave.current = null;
        setReadState((state) => ({ ...state, saving: false }));
      },
    });
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
            disabled={current.saving}
            onChange={(event) => {
              if (pendingSave.current || event.target.value === date) return;
              requests.invalidate();
              setDate(event.target.value);
              setTherapistId("");
              setStartsAt(`${event.target.value}T09:00`);
              setEndsAt(`${event.target.value}T18:00`);
            }}
          />
        </label>
      </div>
      {current.message && (
        <div className="dispatch-message">{current.message}</div>
      )}
      {current.error && (
        <div className="catalog-error" role="alert">
          {current.error}
        </div>
      )}
      <div className="schedule-layout">
        <article className="panel schedule-form">
          <h3>
            <CalendarDays size={18} /> 创建排班
          </h3>
          <label>
            技师
            <select
              value={therapistId}
              disabled={current.phase !== "ready" || current.saving}
              onChange={(event) => setTherapistId(event.target.value)}
            >
              <option value="">选择技师</option>
              {current.board?.technicians.map((technician) => (
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
              disabled={current.phase !== "ready" || current.saving}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </label>
          <label>
            结束时间
            <input
              type="datetime-local"
              value={endsAt}
              disabled={current.phase !== "ready" || current.saving}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </label>
          <button
            className="primary-action"
            disabled={!shiftInput}
            onClick={() => void createShift()}
          >
            {current.saving ? "创建中…" : "创建有效排班"}
          </button>
          {current.phase === "ready" && !shiftInput && !current.saving && (
            <p>
              请选择当前组织技师，开始时间须属于所选日期，结束时间须晚于开始时间。
            </p>
          )}
        </article>
        <article className="panel schedule-list">
          <h3>当日排班 · {date}</h3>
          {current.shifts.map((shift) => (
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
          {current.phase === "loading" && (
            <div className="catalog-empty">正在读取当日排班…</div>
          )}
          {current.phase === "failed" && (
            <div className="catalog-empty">
              排班未读取成功，不代表当日没有排班。
              <button className="ghost-action" onClick={() => void load()}>
                重新读取排班
              </button>
            </div>
          )}
          {current.phase === "ready" && current.shifts.length === 0 && (
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
