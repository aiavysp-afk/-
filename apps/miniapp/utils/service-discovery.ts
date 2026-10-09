import type {
  AvailabilitySlot,
  ServiceItem,
  TechnicianProfile,
} from "@zydj/contracts";
import { api } from "./api";
import {
  buildPublicTherapists,
  type PublicTherapistView,
  type ServiceAvailability,
} from "./therapists";

export type ServiceBookingState =
  | "LOADING"
  | "AVAILABLE"
  | "NO_PROFILE"
  | "NO_SLOTS"
  | "ERROR";

export interface PublicServiceDiscovery {
  services: ServiceItem[];
  therapists: PublicTherapistView[];
  profileCount: number;
  failedServiceIds: string[];
}

const shanghaiDate = (offsetDays: number) =>
  new Date(Date.now() + 8 * 3_600_000 + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

// A single public snapshot supplies both the technician stream and project
// cards. One failed project's schedule must not hide other real technicians.
export const loadPublicServiceDiscovery =
  async (): Promise<PublicServiceDiscovery> => {
    const [profiles, services] = await Promise.all([
      api<TechnicianProfile[]>("/technicians"),
      api<ServiceItem[]>("/catalog/services"),
    ]);
    if (
      profiles.some(
        (profile) =>
          profile.freeTravelFee !== true || profile.travelFeeFen !== 0,
      )
    )
      throw new Error("技师出行费配置异常，已阻止下单");

    if (!profiles.length)
      return {
        services,
        therapists: [],
        profileCount: 0,
        failedServiceIds: [],
      };

    const dates = [shanghaiDate(0), shanghaiDate(1)];
    const results = await Promise.allSettled(
      services.map(async (service): Promise<ServiceAvailability> => {
        const [today, tomorrow] = await Promise.all(
          dates.map((date) =>
            api<AvailabilitySlot[]>(
              `/availability/slots?serviceId=${encodeURIComponent(service.id)}&date=${date}`,
            ),
          ),
        );
        return { service, today: today!, tomorrow: tomorrow! };
      }),
    );
    const rows: ServiceAvailability[] = [];
    const failedServiceIds: string[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") rows.push(result.value);
      else failedServiceIds.push(services[index]!.id);
    });
    const profileOrder = new Map(
      profiles.map((profile, index) => [profile.technicianId, index]),
    );
    const therapists = buildPublicTherapists(rows, profiles).sort(
      (left, right) =>
        (profileOrder.get(left.id) ?? profiles.length) -
        (profileOrder.get(right.id) ?? profiles.length),
    );
    return {
      services,
      therapists,
      profileCount: profiles.length,
      failedServiceIds,
    };
  };

export const serviceBookingState = (
  serviceId: string,
  snapshot: Pick<
    PublicServiceDiscovery,
    "therapists" | "profileCount" | "failedServiceIds"
  >,
): {
  bookingState: ServiceBookingState;
  therapistId: string;
  bookableCount: number;
} => {
  if (snapshot.failedServiceIds.includes(serviceId))
    return { bookingState: "ERROR", therapistId: "", bookableCount: 0 };
  const matches = snapshot.therapists.filter(
    (therapist) =>
      therapist.publishedProfile &&
      therapist.bookable &&
      therapist.services.some(
        (service) => service.id === serviceId && service.slots.length > 0,
      ),
  );
  return {
    bookingState: matches.length
      ? "AVAILABLE"
      : snapshot.profileCount
        ? "NO_SLOTS"
        : "NO_PROFILE",
    therapistId: matches[0]?.id ?? "",
    bookableCount: matches.length,
  };
};

export const serviceBookingLabel = (state: ServiceBookingState) =>
  ({
    LOADING: "读取可约状态…",
    AVAILABLE: "可预约",
    NO_PROFILE: "技师上线中",
    NO_SLOTS: "待开放时段",
    ERROR: "排班读取失败",
  })[state];

export const serviceBookingAction = (state: ServiceBookingState) =>
  ({
    LOADING: "正在更新",
    AVAILABLE: "选技师 ›",
    NO_PROFILE: "待技师上线",
    NO_SLOTS: "时段待开放",
    ERROR: "重试读取 ›",
  })[state];
