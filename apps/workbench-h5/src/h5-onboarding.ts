import type {
  TechnicianH5Application,
  TechnicianH5OnboardingStage,
  TechnicianH5OnboardingStatus,
  TechnicianH5ProfileUpdate,
} from "@zydj/contracts";

export type H5OnboardingStage = TechnicianH5OnboardingStage;
export type H5OnboardingApplication = TechnicianH5Application;
export type H5OnboardingStatus = TechnicianH5OnboardingStatus;
export type H5OnboardingDraft = TechnicianH5ProfileUpdate;

export type H5CatalogService = {
  id: string;
  name: string;
  durationMinutes?: number;
  priceFen?: number;
};

export type H5OnboardingPhotoKind = "AVATAR" | "GALLERY";
export type H5OnboardingDocumentKind = "ID_FRONT" | "ID_BACK";

const IDENTIFIER = /^[A-Za-z0-9_-]{32,256}$/;

export function h5OnboardingPaths() {
  const base = "/technician/h5-onboarding";
  return {
    wechatStart: `${base}/wechat/start`,
    wechatExchange: `${base}/wechat/exchange`,
    smsRequest: "/auth/sms-phone/request",
    smsConfirm: "/auth/sms-phone/confirm",
    status: `${base}/status`,
    register: `${base}/register`,
    profile: `${base}/profile`,
    photos: `${base}/photos`,
    documents: `${base}/documents`,
    submit: `${base}/submit`,
    catalog: "/catalog/services",
  } as const;
}

export function parseWechatCallbackTicket(hash: string) {
  const prefix = "#/wechat-callback?";
  if (!hash.startsWith(prefix)) return null;
  const parameters = new URLSearchParams(hash.slice(prefix.length));
  const ticket = parameters.get("ticket")?.trim() ?? "";
  return IDENTIFIER.test(ticket) ? ticket : null;
}

export function normalizeList(value: string | string[]) {
  const parts = Array.isArray(value) ? value : value.split(/[，,\n]/);
  return [
    ...new Set(parts.map((item) => item.trim()).filter(Boolean)),
  ];
}

export function draftFromApplication(
  application?: H5OnboardingApplication | null,
): H5OnboardingDraft {
  return {
    realName: application?.realName ?? "",
    serviceCity: application?.serviceCity ?? "郑州市",
    serviceAreas: application?.serviceAreas ?? [],
    availableTimeSlots: application?.availableTimeSlots ?? [],
    bio: application?.bio ?? "",
    serviceIds: application?.serviceIds ?? [],
  };
}

export function validateOnboardingDraft(draft: H5OnboardingDraft) {
  if (draft.realName.trim().length < 2) return "请填写与身份证一致的真实姓名";
  if (draft.serviceCity.trim().length < 2) return "请填写服务城市";
  if (!normalizeList(draft.serviceAreas).length) return "请至少填写一个接单区域";
  if (!normalizeList(draft.availableTimeSlots).length)
    return "请至少选择一个可接单时间段";
  if (draft.bio.trim().length < 10) return "个人简介请至少填写10个字";
  if (!draft.serviceIds.length) return "请至少选择一个擅长项目";
  return "";
}

export function isWechatBrowser(userAgent: string) {
  return /MicroMessenger/i.test(userAgent);
}

export function isOnboardingRoute(pathname: string, hash = "") {
  const path = pathname.replace(/\/+$/, "");
  return path === "/technician/onboarding" || hash.startsWith("#/wechat-callback");
}
