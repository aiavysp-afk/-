import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import type { AdminServiceItem, ServiceItem } from "@zydj/contracts";
import { createLatestRequest } from "./synchronization";
import { authenticatedFetch } from "./authenticated-fetch";

type CatalogRow = AdminServiceItem | ServiceItem;
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const response = await authenticatedFetch(token, `${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(
      new Error(body.message ?? `请求失败（${response.status}）`),
      { status: response.status },
    );
  return body as T;
}

export function CatalogWorkspace({
  token,
  onDevelopmentLogin,
  query,
}: {
  token: string;
  onDevelopmentLogin: () => Promise<void>;
  query: string;
}) {
  const scope = useMemo(
    () => ({ requests: createLatestRequest(), alive: true, saving: false }),
    [token],
  );
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const empty = {
    scope,
    services: [] as CatalogRow[],
    loading: true,
    error: "",
    savingId: "",
  };
  const [snapshot, setSnapshot] = useState(empty);
  const { services, loading, error, savingId } =
    snapshot.scope === scope ? snapshot : empty;
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
      update({ loading: true, error: "" });
      try {
        const response = token
          ? await apiRequest<{ data: AdminServiceItem[] }>(
              "/admin/catalog/services",
              {},
              token,
            )
          : await apiRequest<{ data: ServiceItem[] }>("/catalog/services");
        if (!isLatest()) return;
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
    [token, scope],
  );

  useEffect(() => {
    scope.alive = true;
    void load();
    return () => {
      scope.alive = false;
      scope.requests.invalidate();
    };
  }, [load, scope]);

  async function togglePublished(service: AdminServiceItem) {
    if (!token || !isActive() || scope.saving) return;
    scope.saving = true;
    scope.requests.invalidate();
    update({ savingId: service.id, loading: false, error: "" });
    try {
      const action = service.published ? "unpublish" : "publish";
      await apiRequest(
        `/admin/catalog/services/${service.id}/${action}`,
        { method: "POST" },
        token,
      );
      if (isActive()) await load(true);
    } catch (caught) {
      update({
        error: caught instanceof Error ? caught.message : "状态更新失败",
      });
    } finally {
      scope.saving = false;
      update({ savingId: "" });
    }
  }
  const visibleServices = services.filter((service) => {
    const needle = query.trim().toLowerCase();
    return (
      !needle ||
      [service.name, service.subtitle, service.category].some((value) =>
        value.toLowerCase().includes(needle),
      )
    );
  });

  return (
    <section className="catalog-workspace">
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">SERVICE CATALOG</span>
          <h2>服务项目</h2>
          <p>
            {token
              ? "从 PostgreSQL 读取，可安全控制上架状态。"
              : "当前为公开目录只读视图。"}
          </p>
        </div>
        <div className="catalog-actions">
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
      {error && <div className="catalog-error">{error}</div>}

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
                {service.category === "FOOT_CARE"
                  ? "足部舒缓"
                  : service.category === "SPA_RELAXATION"
                    ? "SPA 放松"
                    : "按摩舒缓"}
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
