import { useState } from "react";
import type { AdminServiceItem, ServiceAdminUpdate } from "@zydj/contracts";

export const catalogCategories = [
  { value: "MASSAGE", label: "按摩舒缓" },
  { value: "SPA_RELAXATION", label: "SPA 放松" },
  { value: "FOOT_CARE", label: "足部舒缓" },
] as const;

export type CatalogDraft = {
  name: string;
  category: string;
  subtitle: string;
  description: string;
  durationMinutes: string;
  priceYuan: string;
  badge: string;
  featured: boolean;
  steps: string;
  boundaries: string;
};

export function catalogDraft(service?: AdminServiceItem): CatalogDraft {
  return {
    name: service?.name ?? "",
    category: service?.category ?? "MASSAGE",
    subtitle: service?.subtitle ?? "",
    description: service?.description ?? "",
    durationMinutes: service ? String(service.durationMinutes) : "",
    priceYuan: service ? (service.priceFen / 100).toFixed(2) : "",
    badge: service?.badge ?? "",
    featured: service?.featured ?? false,
    steps: service?.steps.join("\n") ?? "",
    boundaries: service?.boundaries.join("\n") ?? "",
  };
}

/** Convert the decimal input exactly; do not round accidental fractions of a fen. */
export function catalogPriceFen(value: string): number | null {
  const raw = value.trim();
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(raw)) return null;
  const [yuan, fraction = ""] = raw.split(".");
  const result = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) && result <= 100_000_000 ? result : null;
}

export function validateCatalogDraft(draft: CatalogDraft): {
  errors: string[];
  input: ServiceAdminUpdate | null;
} {
  const errors: string[] = [];
  const name = draft.name.trim();
  const subtitle = draft.subtitle.trim();
  const description = draft.description.trim();
  const badge = draft.badge.trim();
  const category = catalogCategories.find(
    (item) => item.value === draft.category,
  )?.value;
  const priceFen = catalogPriceFen(draft.priceYuan);
  const durationMinutes = /^\d+$/.test(draft.durationMinutes.trim())
    ? Number(draft.durationMinutes)
    : NaN;
  const steps = draft.steps
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const boundaries = draft.boundaries
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (name.length < 2 || name.length > 80)
    errors.push("项目名称须为2–80个字符。");
  if (!category) errors.push("请选择有效的项目分类。");
  if (subtitle.length < 2 || subtitle.length > 120)
    errors.push("项目卖点须为2–120个字符。");
  if (description.length < 10 || description.length > 2_000)
    errors.push("服务介绍须为10–2000个字符。");
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 30 ||
    durationMinutes > 480
  )
    errors.push("服务时长须为30–480之间的整数分钟。");
  if (priceFen === null) errors.push("价格须为0–1000000元，最多两位小数。");
  if (badge.length > 30) errors.push("展示标签不能超过30个字符。");
  if (
    steps.length < 1 ||
    steps.length > 20 ||
    steps.some((line) => line.length > 120)
  )
    errors.push("服务流程须填写1–20项，每行一项且不超过120个字符。");
  if (
    boundaries.length < 1 ||
    boundaries.length > 20 ||
    boundaries.some((line) => line.length > 160)
  )
    errors.push("服务说明须填写1–20项，每行一项且不超过160个字符。");
  if (errors.length || !category || priceFen === null)
    return { errors, input: null };
  return {
    errors,
    input: {
      name,
      category,
      subtitle,
      description,
      durationMinutes,
      priceFen,
      badge: badge || null,
      featured: draft.featured,
      steps,
      boundaries,
    },
  };
}

export function CatalogServiceEditor({
  service,
  busy,
  onSave,
  onCancel,
}: {
  service?: AdminServiceItem;
  busy: boolean;
  onSave: (input: ServiceAdminUpdate) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => catalogDraft(service));
  const [errors, setErrors] = useState<string[]>([]);
  const [review, setReview] = useState<ServiceAdminUpdate | null>(null);
  function change<K extends keyof CatalogDraft>(
    key: K,
    value: CatalogDraft[K],
  ) {
    if (busy) return;
    setDraft((previous) => ({ ...previous, [key]: value }));
    setErrors([]);
  }
  const title = service ? `编辑项目：${service.name}` : "新增服务项目";
  return (
    <section className="catalog-editor panel" aria-label={title}>
      <h3>{review ? "确认项目内容" : title}</h3>
      <p>
        {service
          ? "修改后用于后续展示与预约，已有订单以订单记录为准。"
          : "新增项目先保存为下架状态，检查内容后可在列表单独上架。"}
      </p>
      {errors.length > 0 && (
        <ul className="catalog-error" role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      {review ? (
        <>
          <dl className="catalog-review">
            <div>
              <dt>项目名称</dt>
              <dd>{review.name}</dd>
            </div>
            <div>
              <dt>分类</dt>
              <dd>
                {
                  catalogCategories.find(
                    (item) => item.value === review.category,
                  )?.label
                }
              </dd>
            </div>
            <div>
              <dt>价格 / 时长</dt>
              <dd>
                ¥{(review.priceFen! / 100).toFixed(2)} /{" "}
                {review.durationMinutes}分钟
              </dd>
            </div>
            <div>
              <dt>项目卖点</dt>
              <dd>{review.subtitle}</dd>
            </div>
            <div>
              <dt>服务介绍</dt>
              <dd>{review.description}</dd>
            </div>
            <div>
              <dt>展示标签</dt>
              <dd>{review.badge || "未设置"}</dd>
            </div>
            <div>
              <dt>首页推荐</dt>
              <dd>{review.featured ? "是" : "否"}</dd>
            </div>
            <div>
              <dt>服务流程</dt>
              <dd>{review.steps?.join("；")}</dd>
            </div>
            <div>
              <dt>服务说明</dt>
              <dd>{review.boundaries?.join("；")}</dd>
            </div>
          </dl>
          <div className="catalog-actions">
            <button
              className="primary-action"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void onSave(review)}
            >
              {busy ? "正在保存…" : "确认保存项目"}
            </button>
            <button
              className="ghost-action"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              返回修改
            </button>
            <button className="ghost-action" disabled={busy} onClick={onCancel}>
              取消
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            const result = validateCatalogDraft(draft);
            setErrors(result.errors);
            if (result.input) setReview(result.input);
          }}
        >
          <div className="catalog-editor-grid">
            <label>
              项目名称
              <input
                value={draft.name}
                maxLength={80}
                disabled={busy}
                onChange={(event) => change("name", event.target.value)}
              />
            </label>
            <label>
              项目分类
              <select
                value={draft.category}
                disabled={busy}
                onChange={(event) => change("category", event.target.value)}
              >
                {catalogCategories.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              价格（元）
              <input
                inputMode="decimal"
                value={draft.priceYuan}
                disabled={busy}
                placeholder="如 218.00"
                onChange={(event) => change("priceYuan", event.target.value)}
              />
            </label>
            <label>
              服务时长（分钟）
              <input
                inputMode="numeric"
                value={draft.durationMinutes}
                disabled={busy}
                placeholder="30–480"
                onChange={(event) =>
                  change("durationMinutes", event.target.value)
                }
              />
            </label>
            <label className="catalog-editor-wide">
              项目卖点
              <input
                value={draft.subtitle}
                maxLength={120}
                disabled={busy}
                onChange={(event) => change("subtitle", event.target.value)}
              />
            </label>
            <label className="catalog-editor-wide">
              服务介绍
              <textarea
                value={draft.description}
                maxLength={2_000}
                rows={4}
                disabled={busy}
                onChange={(event) => change("description", event.target.value)}
              />
            </label>
            <label>
              展示标签（选填）
              <input
                value={draft.badge}
                maxLength={30}
                disabled={busy}
                onChange={(event) => change("badge", event.target.value)}
              />
            </label>
            <label className="catalog-editor-featured">
              <input
                type="checkbox"
                checked={draft.featured}
                disabled={busy}
                onChange={(event) => change("featured", event.target.checked)}
              />
              首页推荐
            </label>
            <label>
              服务流程（每行一项）
              <textarea
                value={draft.steps}
                rows={5}
                disabled={busy}
                onChange={(event) => change("steps", event.target.value)}
              />
            </label>
            <label>
              服务说明与边界（每行一项）
              <textarea
                value={draft.boundaries}
                rows={5}
                disabled={busy}
                onChange={(event) => change("boundaries", event.target.value)}
              />
            </label>
          </div>
          <div className="catalog-actions">
            <button type="submit" className="primary-action" disabled={busy}>
              下一步，核对内容
            </button>
            <button
              type="button"
              className="ghost-action"
              disabled={busy}
              onClick={onCancel}
            >
              取消
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
