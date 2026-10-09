import type {
  AvailabilitySlot,
  ServiceItem,
  TechnicianProfile,
  TechnicianReview,
} from "@zydj/contracts";
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

export interface PublicTechnicianReviewView extends TechnicianReview {
  dateLabel: string;
  ratingLabel: string;
  stars: string;
}

export interface PublicTherapistView {
  id: string;
  alias: string;
  avatarIndex: number;
  avatarUrl: string;
  badge: string;
  bookable: boolean;
  completedOrdersLabel: string;
  earliestLabel: string;
  galleryUrls: string[];
  orderCountLabel: string;
  profile: string;
  publishedProfile: boolean;
  qualifications: string[];
  ratingLabel: string;
  reviewCount: number;
  services: TherapistServiceView[];
  statusLabel: string;
  statusTone: "online" | "scheduled";
  tags: string[];
  todaySlotCount: number;
  tomorrowSlotCount: number;
  travelLabel: string;
  yearsExperienceLabel: string;
}

export interface PublicTherapistDetailView extends PublicTherapistView {
  reviews: PublicTechnicianReviewView[];
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

const statusLabel = (todaySlotCount: number, tomorrowSlotCount: number) => {
  if (todaySlotCount > 0) return "今日可约";
  if (tomorrowSlotCount > 0) return "明日可约";
  return "暂不可约";
};

const formatRating = (profile: TechnicianProfile | undefined) => {
  if (
    !profile ||
    profile.reviewSummary.averageRating === null ||
    profile.reviewSummary.reviewCount === 0
  )
    return "暂无评价";
  return `${profile.reviewSummary.averageRating.toFixed(1)}分 · ${profile.reviewSummary.reviewCount}条`;
};

export const buildPublicTherapists = (
  rows: ServiceAvailability[],
  profiles: TechnicianProfile[] = [],
) => {
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

  // Published profiles without a future shift remain visible, but cannot be
  // booked until the shared scheduling backend returns a real slot.
  for (const profile of profiles) {
    if (!records.has(profile.technicianId)) {
      records.set(profile.technicianId, {
        services: new Map<string, TherapistServiceView>(),
        todaySlotCount: 0,
        tomorrowSlotCount: 0,
      });
    }
  }

  const profileById = new Map(
    profiles.map((profile) => [profile.technicianId, profile]),
  );
  return [...records.entries()]
    .filter(([id]) => profileById.has(id))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, record], index): PublicTherapistView => {
      const profile = profileById.get(id);
      if (!profile) throw new Error("技师公开资料缺失");
      const services = [...record.services.values()];
      const earliest = services
        .flatMap((service) => service.slots)
        .sort((left, right) => left.startsAt.localeCompare(right.startsAt))[0];
      const bookable = services.some((service) => service.slots.length > 0);
      return {
        id,
        alias: profile.publicName,
        avatarIndex: index % 4,
        avatarUrl: profile.avatarUrl ?? "",
        badge: bookable ? "优先可约" : "资料已公开",
        bookable,
        completedOrdersLabel: `${profile.reviewSummary.completedOrders}单`,
        earliestLabel: earliest
          ? `${earliest.dayLabel} ${earliest.timeLabel}`
          : "暂无可约时间",
        galleryUrls: profile.galleryUrls,
        orderCountLabel: `${profile.reviewSummary.completedOrders}单已完成`,
        profile:
          profile.introduction ||
          "该技师尚未发布公开介绍，平台不会代为填写虚构资料。",
        publishedProfile: true,
        qualifications: profile.certificates,
        ratingLabel: formatRating(profile),
        reviewCount: profile.reviewSummary.reviewCount,
        services,
        statusLabel: statusLabel(
          record.todaySlotCount,
          record.tomorrowSlotCount,
        ),
        statusTone: record.todaySlotCount > 0 ? "online" : "scheduled",
        tags: profile.specialties.length
          ? profile.specialties
          : ["平台核验", bookable ? "已排班" : "待排班"],
        todaySlotCount: record.todaySlotCount,
        tomorrowSlotCount: record.tomorrowSlotCount,
        travelLabel: "免出行费",
        yearsExperienceLabel:
          profile.serviceYears === null
            ? "待公开"
            : `${profile.serviceYears}年`,
      };
    });
};

export const loadPublicTherapists = async () => {
  const [profiles, services] = await Promise.all([
    api<TechnicianProfile[]>("/technicians"),
    api<ServiceItem[]>("/catalog/services"),
  ]);
  if (
    profiles.some(
      (profile) => profile.freeTravelFee !== true || profile.travelFeeFen !== 0,
    )
  )
    throw new Error("技师出行费配置异常，已阻止下单");
  if (!profiles.length) return [];
  const today = shanghaiDate(0);
  const tomorrow = shanghaiDate(1);
  const results = await Promise.allSettled(
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
  const rows = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const incomplete = results.some((result) => result.status === "rejected");
  if (services.length && !rows.length)
    throw new Error("项目排班读取失败，请重新加载");
  return buildPublicTherapists(rows, profiles).map((therapist) =>
    !therapist.bookable && incomplete
      ? {
          ...therapist,
          statusLabel: "排班待确认",
          earliestLabel: "排班读取不完整",
        }
      : therapist,
  );
};

export const loadPublicTherapist = async (
  technicianId: string,
): Promise<PublicTherapistDetailView> => {
  const [therapists, profile, reviews] = await Promise.all([
    loadPublicTherapists(),
    api<TechnicianProfile>(`/technicians/${encodeURIComponent(technicianId)}`),
    api<TechnicianReview[]>(
      `/technicians/${encodeURIComponent(technicianId)}/reviews`,
    ),
  ]);
  const therapist = therapists.find((item) => item.id === technicianId);
  if (!therapist || profile.technicianId !== technicianId)
    throw new Error("该技师资料尚未公开");
  return {
    ...therapist,
    reviews: reviews.map((review) => ({
      ...review,
      content: review.content.trim(),
      dateLabel: shanghaiTime(review.createdAt).slice(0, 10),
      ratingLabel: `${review.rating}星`,
      stars: "★".repeat(review.rating),
    })),
  };
};
