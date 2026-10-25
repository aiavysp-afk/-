import { useEffect, useRef, useState } from "react";
import { authenticatedFetch } from "./authenticated-fetch";
const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
export function PhotoShowcaseControl({
  token,
  organizationId,
  technicianId,
  version,
  published,
  disabled,
  onSaved,
}: {
  token: string;
  organizationId: string;
  technicianId: string;
  version: number;
  published: boolean;
  disabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setBusy(false);
    setError("");
    return () => {
      generation.current++;
    };
  }, [technicianId, version, token]);
  async function save(enabled = !published) {
    if (busy || disabled) return;
    const ticket = generation.current;
    setBusy(true);
    setError("");
    try {
      const response = await authenticatedFetch(
        token,
        `${API}/admin/organizations/${encodeURIComponent(organizationId)}/technicians/${encodeURIComponent(technicianId)}/profile/showcase`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ expectedVersion: version, enabled }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "照片展示设置未完成");
      if (generation.current === ticket) await onSaved();
    } catch (e) {
      if (generation.current === ticket)
        setError(e instanceof Error ? e.message : "保存失败，请刷新核对");
    } finally {
      if (generation.current === ticket) setBusy(false);
    }
  }
  return (
    <section className="profile-admin-form" aria-label="形象照公开展示">
      <h4>小程序形象照展示</h4>
      <p>
        发布当前头像到首页及技师风采相册。其他个人资料可留空；资料审核和排班完成后再开放预约。头像更换后需重新发布。
      </p>
      <p role="status">{published ? "已发布一张形象照" : "形象照尚未发布"}</p>
      {error && (
        <p role="alert" className="catalog-error">
          {error}
        </p>
      )}
      <button
        type="button"
        className="primary-action"
        disabled={busy || disabled}
        onClick={() => void save()}
      >
        {busy ? "正在保存…" : published ? "撤下展示照片" : "展示当前形象照"}
      </button>
      {published && (
        <button
          type="button"
          className="ghost-action"
          disabled={busy || disabled}
          onClick={() => void save(true)}
        >
          用当前头像更新展示
        </button>
      )}
    </section>
  );
}
