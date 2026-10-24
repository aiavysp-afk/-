import { useState } from "react";
import {
  AdminTechnicianApplicationUpdateSchema,
  type TechnicianApplication,
  type ServiceItem,
  type AdminTechnicianApplicationUpdate,
} from "@zydj/contracts";

export function ApplicationEditor({
  application,
  services,
  disabled,
  onSave,
}: {
  application: TechnicianApplication;
  services: ServiceItem[];
  disabled: boolean;
  onSave: (value: AdminTechnicianApplicationUpdate) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState(application.realName || "");
  const [city, setCity] = useState(application.serviceCity || "");
  const [areas, setAreas] = useState(application.serviceAreas.join("、"));
  const [slots, setSlots] = useState(application.availableTimeSlots);
  const [days, setDays] = useState<string[]>([]);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const [ids, setIds] = useState(application.serviceIds);
  const [bio, setBio] = useState(application.introduction);
  if (!editing)
    return (
      <button
        type="button"
        className="ghost-action"
        disabled={disabled}
        onClick={() => setEditing(true)}
      >
        补录 / 修改入驻资料
      </button>
    );
  return (
    <form
      className="profile-admin-form"
      aria-label="补录入驻资料"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || disabled) return;
        const value = AdminTechnicianApplicationUpdateSchema.safeParse({
          expectedVersion: application.version,
          profile: {
            realName: name,
            ...(city.trim() ? { serviceCity: city.trim() } : {}),
            serviceAreas: [
              ...new Set(
                areas
                  .split(/[、,，\n]/)
                  .map((x) => x.trim())
                  .filter(Boolean),
              ),
            ],
            availableTimeSlots: slots,
            serviceIds: ids,
            bio,
          },
        });
        if (!value.success) {
          setError(
            "请检查城市、区域、时段和简介格式；区域名称至少2字，结束时间应晚于开始时间。",
          );
          return;
        }
        setBusy(true);
        setError("");
        try {
          if (await onSave(value.data)) setEditing(false);
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy || disabled}>
        <legend>入驻资料补录</legend>
        <p>
          保存后转为草稿，需重新提交审核；原有照片、证件和订单保留。真实姓名仅供后台审核。
        </p>
        <label>
          真实姓名
          <input
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          服务城市
          <input
            value={city}
            maxLength={32}
            placeholder="例如：郑州市"
            onChange={(e) => setCity(e.target.value)}
          />
        </label>
        <label>
          接单区域
          <textarea
            value={areas}
            placeholder="多个区域用顿号分隔"
            onChange={(e) => setAreas(e.target.value)}
          />
        </label>
        <div>可接单时段</div>
        {slots.map((slot) => (
          <button
            type="button"
            key={slot}
            className="ghost-action"
            onClick={() => setSlots(slots.filter((s) => s !== slot))}
          >
            {slot} ×
          </button>
        ))}
        <div>
          {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((day, i) => (
            <label key={day}>
              <input
                type="checkbox"
                checked={days.includes(day)}
                onChange={(e) =>
                  setDays(
                    e.target.checked
                      ? [...days, day]
                      : days.filter((d) => d !== day),
                  )
                }
              />
              {["周一", "周二", "周三", "周四", "周五", "周六", "周日"][i]}
            </label>
          ))}
        </div>
        <label>
          开始时间
          <input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          结束时间
          <input
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="ghost-action"
          disabled={!days.length || !start || !end || start >= end}
          onClick={() =>
            setSlots([
              ...new Set([
                ...slots,
                ...days.map((day) => `${day}:${start}-${end}`),
              ]),
            ])
          }
        >
          添加时段
        </button>
        <p>这里填写意向时段，审核通过后还需在排班中心安排实际接单班次。</p>
        <div>擅长项目</div>
        {services.map((service) => (
          <label key={service.id}>
            <input
              type="checkbox"
              checked={ids.includes(service.id)}
              onChange={(e) =>
                setIds(
                  e.target.checked
                    ? [...ids, service.id]
                    : ids.filter((id) => id !== service.id),
                )
              }
            />
            {service.name}
          </label>
        ))}
        <label>
          个人简介
          <textarea
            value={bio}
            maxLength={2000}
            onChange={(e) => setBio(e.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" className="primary-action" aria-busy={busy}>
          {busy ? "正在保存…" : "保存补录资料"}
        </button>
        <button
          type="button"
          className="ghost-action"
          onClick={() => setEditing(false)}
        >
          取消
        </button>
      </fieldset>
    </form>
  );
}
