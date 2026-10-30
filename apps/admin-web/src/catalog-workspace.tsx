import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import type {
  AdminServiceItem,
  ServiceAdminUpdate,
  ServiceItem,
} from "@zydj/contracts";
import { createLatestRequest } from "./synchronization";
import { authenticatedFetch } from "./authenticated-fetch";
import {
  CatalogServiceEditor,
  catalogCategories,
} from "./catalog-service-editor";
import "./catalog-management.css";

type CatalogRow = AdminServiceItem | ServiceItem;
type CatalogEditor =
  | { kind: "create"; clientRequestId: string }
  | { kind: "edit" | "delete"; service: AdminServiceItem };
type StatusFilter = "all" | "published" | "unpublished";
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const response = await authenticatedFetch(token, `${API_BASE_URL}${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw Object.assign(
      new Error(body?.message ?? `请求失败（${response.status}）`),
      { status: response.status },
    );
  if (!body || typeof body !== "object" || body.data == null)
    throw Error("服务项目接口未返回有效结果，请刷新目录确认操作状态。");
  return body as T;
}

export function CatalogWorkspace({
  token,
  onDevelopmentLogin,
  query,
  organizationId = "",
  onOpenSecurity,
}: {
  token: string;
  onDevelopmentLogin: () => Promise<void>;
  query: string;
  organizationId?: string;
  onOpenSecurity?: () => void;
}) {
  const scope = useMemo(
    () => ({ requests: createLatestRequest(), alive: true, saving: false }),
    [token, organizationId],
  );
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const empty = {
    scope,
    services: [] as CatalogRow[],
    loading: true,
    error: "",
    savingId: "",
    editor: null as CatalogEditor | null,
    statusFilter: "all" as StatusFilter,
    notice: "",
    needsSecurity: false,
    needsRefresh: false,
  };
  const [snapshot, setSnapshot] = useState(empty);
  const {
    services,
    loading,
    error,
    savingId,
    editor,
    statusFilter,
    notice,
    needsSecurity,
    needsRefresh,
  } = snapshot.scope === scope ? snapshot : empty;
  const isActive = () => currentScope.current === scope && scope.alive;
  function update(patch: Partial<Omit<typeof empty, "scope">>) {
    if (!isActive()) return;
    setSnapshot((previous) => {
      if (!isActive()) return previous;
      return { ...(previous.scope === scope ? previous : empty), ...patch };
    });
  }

  const load = useCallback(
    async (afterMutation = false) => {
      if (!isActive() || (scope.saving && !afterMutation)) return;
      const isLatest = scope.requests.begin();
      update({ loading: true, error: "", needsSecurity: false });
      try {
        const response = token
          ? await apiRequest<{ data: AdminServiceItem[] }>(
              `/admin/catalog/services${organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : ""}`,
              {},
              token,
            )
          : await apiRequest<{ data: ServiceItem[] }>("/catalog/services");
        if (!isLatest()) return;
        if (!Array.isArray(response.data))
          throw Error("服务目录返回格式异常，请稍后刷新。");
        update({
          services: response.data.filter(
            (service) =>
              token || !("published" in service) || service.published,
          ),
        });
      } catch (caught) {
        if (!isLatest()) return;
        update({
          services: [],
          error: caught instanceof Error ? caught.message : "服务目录加载失败",
        });
      } finally {
        if (isLatest()) update({ loading: false });
      }
    },
    [token, organizationId, scope],
  );

  useEffect(() => {
    scope.alive = true;
    void load();
    return () => {
      scope.alive = false;
      scope.requests.invalidate();
    };
  }, [load, scope]);

  async function mutate(
    id: string,
    request: () => Promise<unknown>,
    success: string,
  ) {
    if (!token || !isActive() || scope.saving) return;
    scope.saving = true;
    scope.requests.invalidate();
    update({
      savingId: id,
      loading: false,
      error: "",
      notice: "",
      needsSecurity: false,
      needsRefresh: false,
    });
    try {
      const result = (await request()) as { data?: { id?: unknown } };
      if (
        typeof result?.data?.id !== "string" ||
        !result.data.id ||
        (id !== "new" && result.data.id !== id)
      )
        throw Error("服务项目接口未返回有效记录，请刷新目录确认操作状态。");
      if (isActive()) {
        update({ editor: null, notice: success });
        await load(true);
      }
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "项目操作未完成，请稍后重试";
      update({
        error: message,
        needsSecurity:
          (caught as { status?: number })?.status === 403 &&
          /动态码|账户安全|多因素验证/.test(message),
        needsRefresh: (caught as { status?: number })?.status === 409,
      });
    } finally {
      scope.saving = false;
      update({ savingId: "" });
    }
  }
  async function togglePublished(service: AdminServiceItem) {
    const action = service.published ? "unpublish" : "publish";
    await mutate(
      service.id,
      () =>
        apiRequest(
          `/admin/catalog/services/${encodeURIComponent(service.id)}/${action}`,
          { method: "POST" },
          token,
        ),
      service.published
        ? "项目已下架，小程序将停止展示和新增预约，历史订单保留。"
        : "项目已上架，小程序重新读取目录后显示。能否预约仍以技师排班为准。",
    );
  }
  async function saveEditor(input: ServiceAdminUpdate) {
    if (!editor || editor.kind === "delete" || !organizationId) return;
    const creating = editor.kind === "create";
    const path = creating
      ? "/admin/catalog/services"
      : `/admin/catalog/services/${encodeURIComponent(editor.service.id)}`;
    const body = creating
      ? { ...input, organizationId, clientRequestId: editor.clientRequestId }
      : { ...input, expectedUpdatedAt: editor.service.updatedAt };
    await mutate(
      creating ? "new" : editor.service.id,
      () =>
        apiRequest(
          path,
          {
            method: creating ? "POST" : "PATCH",
            body: JSON.stringify(body),
          },
          token,
        ),
      creating
        ? "项目已新增，当前为下架状态。检查内容后可在列表上架。"
        : "项目内容已保存。已上架的项目会在小程序重新读取目录后更新。",
    );
  }
  async function discardEditorAndRefresh() {
    if (!isActive() || scope.saving) return;
    update({
      editor: null,
      error: "",
      needsRefresh: false,
      needsSecurity: false,
      notice: "",
    });
    await load();
  }
  async function deleteEditor() {
    if (!editor || editor.kind !== "delete" || editor.service.published) return;
    const service = editor.service;
    await mutate(
      service.id,
      () =>
        apiRequest(
          `/admin/catalog/services/${encodeURIComponent(service.id)}`,
          {
            method: "DELETE",
            body: JSON.stringify({ expectedUpdatedAt: service.updatedAt }),
          },
          token,
        ),
      "项目已删除。",
    );
  }
  const visibleServices = services.filter((service) => {
    const published = "published" in service ? service.published : true;
    if (statusFilter === "published" && !published) return false;
    if (statusFilter === "unpublished" && published) return false;
    const needle = query.trim().toLowerCase();
    return (
      !needle ||
      [service.name, service.subtitle, service.category].some((value) =>
        value.toLowerCase().includes(needle),
      )
    );
  });

  return (
    <section className="catalog-workspace catalog-management">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">SERVICE CATALOG</span>
          <h2>服务项目</h2>
          <p>
            {token
              ? "统一管理项目内容与上下架，小程序读取同一份服务目录。"
              : "当前为公开目录只读视图。"}
          </p>
        </div>
        <div className="catalog-actions">
          {token && (
            <button
              className="primary-action"
              disabled={loading || Boolean(savingId) || !organizationId}
              onClick={() =>
                update({
                  editor: {
                    kind: "create",
                    clientRequestId: crypto.randomUUID(),
                  },
                  error: "",
                  notice: "",
                  needsRefresh: false,
                })
              }
            >
              新增服务项目
            </button>
          )}
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
            disabled={loading || Boolean(savingId)}
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
              正式环境使用管理员账号密码与本人手机短信登录；敏感操作需独立动态码验证。开发环境可使用明确标记的本地账号。
            </p>
          </div>
        </div>
      )}
      {(error || needsRefresh) && (
        <div className="catalog-error" role="alert">
          {error}
          {needsRefresh && (
            <>
              <p>
                关闭编辑并刷新会丢弃尚未保存的内容，并读取最新项目资料；系统不会自动重新提交。
              </p>
              <button
                className="ghost-action"
                disabled={loading || Boolean(savingId)}
                onClick={() => void discardEditorAndRefresh()}
              >
                关闭编辑并刷新
              </button>
            </>
          )}
          {needsSecurity && onOpenSecurity && (
            <>
              <p>
                请先记录未保存的内容；切换页面后需要重新填写，系统不会自动提交。
              </p>
              <button
                className="ghost-action"
                disabled={Boolean(savingId)}
                onClick={onOpenSecurity}
              >
                前往账户安全验证
              </button>
            </>
          )}
        </div>
      )}
      {notice && (
        <p className="catalog-notice" role="status">
          {notice}
        </p>
      )}
      {token && !organizationId && (
        <p className="catalog-error">
          尚未确定所属组织，暂不能新增项目。请重新验证登录身份。
        </p>
      )}
      {editor && editor.kind !== "delete" && (
        <CatalogServiceEditor
          key={`${editor.kind}:${editor.kind === "create" ? editor.clientRequestId : editor.service.id}`}
          service={editor.kind === "edit" ? editor.service : undefined}
          busy={Boolean(savingId)}
          onSave={saveEditor}
          onCancel={() => {
            if (!scope.saving)
              update({ editor: null, error: "", needsRefresh: false });
          }}
        />
      )}
      {editor?.kind === "delete" && (
        <section className="catalog-delete panel" aria-label="删除项目确认">
          <h3>删除项目：{editor.service.name}</h3>
          <p>
            ¥{(editor.service.priceFen / 100).toFixed(2)} ·{" "}
            {editor.service.durationMinutes}分钟 ·{" "}
            {editor.service.published ? "已上架" : "已下架"}
          </p>
          <p>
            仅可删除已下架且未关联订单、预约或技师资料的项目。已有业务记录的项目请使用下架，历史订单继续保留。
          </p>
          {editor.service.published && (
            <p>请先下架项目。下架会停止新增预约，不会删除历史记录。</p>
          )}
          <div className="catalog-actions">
            {editor.service.published ? (
              <button
                className="primary-action"
                disabled={Boolean(savingId)}
                onClick={() => void togglePublished(editor.service)}
              >
                下架并保留记录
              </button>
            ) : (
              <button
                className="danger-action"
                disabled={Boolean(savingId)}
                aria-busy={Boolean(savingId)}
                onClick={() => void deleteEditor()}
              >
                {savingId ? "正在删除…" : "确认删除项目"}
              </button>
            )}
            <button
              className="ghost-action"
              disabled={Boolean(savingId)}
              onClick={() =>
                update({ editor: null, error: "", needsRefresh: false })
              }
            >
              取消
            </button>
          </div>
        </section>
      )}
      <div className="catalog-toolbar">
        <p>
          共{services.length}个项目 · 已上架
          {
            services.filter(
              (service) => !("published" in service) || service.published,
            ).length
          }
          个 · 下架
          {
            services.filter(
              (service) => "published" in service && !service.published,
            ).length
          }
          个
        </p>
        {token && (
          <label>
            项目状态
            <select
              value={statusFilter}
              disabled={Boolean(savingId)}
              onChange={(event) =>
                update({ statusFilter: event.target.value as StatusFilter })
              }
            >
              <option value="all">全部项目</option>
              <option value="published">已上架</option>
              <option value="unpublished">已下架</option>
            </select>
          </label>
        )}
      </div>

      <div className="catalog-table panel">
        <div className="catalog-row catalog-table-head">
          <span>项目</span>
          <span>类别</span>
          <span>时长</span>
          <span>价格</span>
          <span>状态</span>
          <span>操作</span>
        </div>
        {visibleServices.map((service) => {
          const adminService =
            token && "published" in service ? service : undefined;
          return (
            <div className="catalog-row" key={service.id}>
              <span className="service-cell">
                <b>{service.name}</b>
                <small>{service.subtitle}</small>
              </span>
              <span>
                {catalogCategories.find(
                  (item) => item.value === service.category,
                )?.label ?? "其他分类"}
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
                  <span className="catalog-row-actions">
                    <button
                      className="ghost-action"
                      disabled={loading || Boolean(savingId)}
                      onClick={() =>
                        update({
                          editor: { kind: "edit", service: adminService },
                          error: "",
                          notice: "",
                          needsRefresh: false,
                        })
                      }
                    >
                      编辑
                    </button>
                    <button
                      className={
                        adminService.published
                          ? "danger-action"
                          : "primary-action compact"
                      }
                      onClick={() => void togglePublished(adminService)}
                      disabled={loading || Boolean(savingId)}
                    >
                      {savingId === service.id
                        ? "处理中…"
                        : adminService.published
                          ? "下架"
                          : "上架"}
                    </button>
                    <button
                      className="danger-action"
                      disabled={loading || Boolean(savingId)}
                      onClick={() =>
                        update({
                          editor: { kind: "delete", service: adminService },
                          error: "",
                          notice: "",
                          needsRefresh: false,
                        })
                      }
                    >
                      删除
                    </button>
                  </span>
                ) : (
                  <small>只读</small>
                )}
              </span>
            </div>
          );
        })}
        {!loading && visibleServices.length === 0 && (
          <div className="catalog-empty">
            {query.trim() ? "没有匹配的服务项目" : "暂无服务项目"}
          </div>
        )}
        {loading && <div className="catalog-empty">正在读取服务目录…</div>}
      </div>
    </section>
  );
}
