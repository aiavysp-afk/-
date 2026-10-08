import type { AvailabilitySlot, ServiceItem } from "@zydj/contracts";
import { api, money, shanghaiTime } from "./api";

export interface TherapistSlotView extends AvailabilitySlot {
  day: "TODAY" | "TOMORROW";
  dayLabel: string;
  timeLabel: string;
}

export interface TherapistServiceView extends ServiceItem {
  price: string;
  slots: TherapistSlotView[];
}

export interface PublicTherapistView {
  id: string;
  alias: string;
  avatarIndex: number;
  badge: string;
  bookable: boolean;
  earliestLabel: string;
  orderCountLabel: string;
  profile: string;
  ratingLabel: string;
  services: TherapistServiceView[];
  statusLabel: string;
  statusTone: "online" | "scheduled";
  storeLabel: string;
  tags: string[];
  todaySlotCount: number;
  tomorrowSlotCount: number;
  travelLabel: string;
}

export interface ServiceAvailability {
  service: ServiceItem;
  today: AvailabilitySlot[];
  tomorrow: AvailabilitySlot[];
}

const shanghaiDate = (offsetDays: number) =>
  new Date(Date.now() + 8 * 60 * 60 * 1_000 + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

export const buildPublicTherapists = (rows: ServiceAvailability[]) => {
  const records = new Map<
    string,
    {
      services: Map<string, TherapistServiceView>;
      todaySlotCount: number;
      tomorrowSlotCount: number;
    }
  >();

  for (const row of rows) {
    const slots: TherapistSlotView[] = [
      ...row.today.map((slot) => ({
        ...slot,
        day: "TODAY" as const,
        dayLabel: "今天",
        timeLabel: shanghaiTime(slot.startsAt),
      })),
      ...row.tomorrow.map((slot) => ({
        ...slot,
        day: "TOMORROW" as const,
        dayLabel: "明天",
        timeLabel: shanghaiTime(slot.startsAt),
      })),
    ];
    const therapistIds = [...new Set(slots.map((slot) => slot.therapistId))];
    for (const therapistId of therapistIds) {
      const record = records.get(therapistId) ?? {
        services: new Map<string, TherapistServiceView>(),
        todaySlotCount: 0,
        tomorrowSlotCount: 0,
      };
      const therapistSlots = slots
        .filter((slot) => slot.therapistId === therapistId)
        .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
      record.todaySlotCount += therapistSlots.filter(
        (slot) => slot.day === "TODAY",
      ).length;
      record.tomorrowSlotCount += therapistSlots.filter(
        (slot) => slot.day === "TOMORROW",
      ).length;
      record.services.set(row.service.id, {
        ...row.service,
        price: money(row.service.priceFen),
        slots: therapistSlots,
      });
      records.set(therapistId, record);
    }
  }

  return [...records.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, record], index): PublicTherapistView => {
      const services = [...record.services.values()];
      const earliest = services
        .flatMap((service) => service.slots)
        .sort((left, right) => left.startsAt.localeCompare(right.startsAt))[0];
      const availableToday = record.todaySlotCount > 0;
      return {
        id,
        alias: `认证技师 ${String(index + 1).padStart(2, "0")}`,
        avatarIndex: index % 4,
        badge: availableToday ? "优先可约" : "预约开放",
        bookable: services.length > 0,
        earliestLabel: earliest
          ? `${earliest.dayLabel} ${earliest.timeLabel}`
          : "暂无可约时间",
        orderCountLabel: "履约数据待授权",
        profile:
          "平台已完成基础资料核验。为保护服务人员隐私，真实姓名、照片及更多职业资料仅在取得本人公开展示授权后提供。",
        ratingLabel: "暂无公开评分",
        services,
        statusLabel: availableToday ? "今日可约" : "明日可约",
        statusTone: availableToday ? "online" : "scheduled",
        storeLabel: "所属门店资料待公开",
        tags: ["平台核验", availableToday ? "今日有排班" : "明日有排班"],
        todaySlotCount: record.todaySlotCount,
        tomorrowSlotCount: record.tomorrowSlotCount,
        travelLabel: "出行费按地址报价",
      };
    });
};

export const loadPublicTherapists = async () => {
  const services = await api<ServiceItem[]>("/catalog/services");
  const today = shanghaiDate(0);
  const tomorrow = shanghaiDate(1);
  const rows = await Promise.all(
    services.map(async (service): Promise<ServiceAvailability> => {
      const [todaySlots, tomorrowSlots] = await Promise.all([
        api<AvailabilitySlot[]>(
          `/availability/slots?serviceId=${encodeURIComponent(service.id)}&date=${today}`,
        ),
        api<AvailabilitySlot[]>(
          `/availability/slots?serviceId=${encodeURIComponent(service.id)}&date=${tomorrow}`,
        ),
      ]);
      return { service, today: todaySlots, tomorrow: tomorrowSlots };
    }),
  );
  return buildPublicTherapists(rows);
};
