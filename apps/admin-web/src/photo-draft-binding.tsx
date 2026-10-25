import { useEffect, useRef, useState } from "react";
import type { TechnicianPhotoDraftTargets } from "@zydj/contracts";
import { authenticatedFetch } from "./authenticated-fetch";

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
export function PhotoDraftBinding({
  token,
  organizationId,
  technicianId,
  sourceVersion,
  disabled,
  onLinked,
  onOpenApplication,
}: {
  token: string;
  organizationId: string;
  technicianId: string;
  sourceVersion: number;
  disabled: boolean;
  onLinked: () => Promise<void>;
  onOpenApplication: (id: string) => void;
}) {
  const [result, setResult] = useState<TechnicianPhotoDraftTargets | null>(
    null,
  );
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const prefix = `${API}/admin/organizations/${encodeURIComponent(organizationId)}/technicians/${encodeURIComponent(technicianId)}/profile`;
  useEffect(() => {
    const ticket = ++generation.current;
    setResult(null);
    setSelected("");
    setError("");
    setBusy(false);
    void authenticatedFetch(token, `${prefix}/binding-targets`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || "关联申请读取失败");
        if (ticket === generation.current) setResult(body.data);
      })
      .catch((e) => {
        if (ticket === generation.current) setError(e.message);
      });
    return () => {
      generation.current++;
    };
  }, [prefix, token, sourceVersion, refresh]);
  async function bind() {
    const target = result?.targets.find((row) => row.technicianId === selected);
    if (!target || busy || disabled) return;
    if (
      !window.confirm(
        `确认将此预建档的照片关联到 ${target.label}（${target.phoneMasked}，申请尾号 ${target.technicianId.slice(-8)}）？\n请核对是同一名技师；仅补充照片，原有资料保留，申请回到草稿重新审核。`,
      )
    )
      return;
    const ticket = generation.current;
    setBusy(true);
    setError("");
    try {
      const response = await authenticatedFetch(
        token,
        `${prefix}/bind-application`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            targetTechnicianId: target.technicianId,
            expectedSourceVersion: sourceVersion,
            expectedTargetVersion: target.version,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.message || "关联失败，请刷新后核对结果");
      if (ticket !== generation.current) return;
      setResult({ boundTechnicianId: target.technicianId, targets: [] });
      await onLinked();
    } catch (e) {
      if (ticket === generation.current)
        setError(
          e instanceof Error
            ? e.message
            : "关联未完成，请先刷新核对，不要重复分配",
        );
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  }
  return (
    <section className="profile-admin-form" aria-label="照片档案关联本人申请">
      <h4>关联技师本人入驻申请</h4>
      <p>
        技师先在入驻页完成本人登录并创建草稿，再按姓名及手机号尾号选择对应申请。原头像存在时保留，预存照片加入相册。
      </p>
      {error && (
        <div className="catalog-error" role="alert">
          {error}
        </div>
      )}
      {!result && !error && <p role="status">正在读取可关联申请…</p>}
      {result?.boundTechnicianId ? (
        <>
          <p role="status">
            已关联本人申请。后续照片及资料请在本人申请中补充。
          </p>
          <button
            type="button"
            className="ghost-action"
            onClick={() => onOpenApplication(result.boundTechnicianId!)}
          >
            查看本人申请
          </button>
        </>
      ) : (
        <>
          {result && !result.targets.length && (
            <p>
              暂时没有可关联的本人入驻草稿。可先保留照片，等技师本人登记后刷新。
            </p>
          )}
          {Boolean(result?.targets.length) && (
            <label>
              选择本人入驻申请
              <select
                value={selected}
                disabled={busy || disabled}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">请选择并核对手机号尾号</option>
                {result?.targets.map((row) => (
                  <option key={row.technicianId} value={row.technicianId}>
                    {row.label} · {row.phoneMasked} ·{" "}
                    {row.technicianId.slice(-8)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="catalog-actions">
            <button
              type="button"
              className="ghost-action"
              disabled={busy || disabled}
              onClick={() => setRefresh((v) => v + 1)}
            >
              刷新本人申请
            </button>
            <button
              type="button"
              className="primary-action"
              disabled={!selected || busy || disabled}
              onClick={() => void bind()}
            >
              {busy ? "正在关联…" : "确认关联照片"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
