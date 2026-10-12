import type {
  ServiceItem,
  TechnicianApplication,
  TechnicianIdentityDocumentKind,
} from "@zydj/contracts";

export type IdentityDocumentKind = TechnicianIdentityDocumentKind;

/**
 * Private onboarding fields returned only by the organization-scoped admin API.
 * They deliberately do not form part of any public technician URL.
 */
export type TechnicianOnboardingReviewProfile = TechnicianApplication;

export function maskRealName(value: string | null | undefined) {
  const name = value?.trim() ?? "";
  if (!name) return "";
  if (name.length === 1) return `${name}*`;
  if (name.length === 2) return `${name[0]}*`;
  return `${name[0]}${"*".repeat(Math.min(name.length - 2, 3))}${name.at(-1)}`;
}

export function onboardingServiceLabels(
  serviceIds: string[] | undefined,
  services: ServiceItem[],
) {
  const names = new Map(services.map((service) => [service.id, service.name]));
  return (serviceIds ?? []).map((serviceId) => names.get(serviceId) ?? serviceId);
}

export function formatAvailabilityTimeSlot(value: string) {
  const match = value.match(
    /^(MON|TUE|WED|THU|FRI|SAT|SUN):(\d{2}:\d{2}-\d{2}:\d{2})$/,
  );
  if (!match) return value;
  const weekdays = {
    MON: "周一",
    TUE: "周二",
    WED: "周三",
    THU: "周四",
    FRI: "周五",
    SAT: "周六",
    SUN: "周日",
  } as const;
  return `${weekdays[match[1] as keyof typeof weekdays]} ${match[2]}`;
}

export function hasIdentityDocument(
  profile: TechnicianOnboardingReviewProfile,
  kind: IdentityDocumentKind,
) {
  return kind === "ID_FRONT"
    ? profile.identityDocuments.idFrontUploaded
    : profile.identityDocuments.idBackUploaded;
}

function validatedApiBase(apiBaseUrl: string) {
  const apiBase = apiBaseUrl.replace(/\/$/, "");
  const api = new URL(apiBase, "https://api.mtsc.top");
  const localHttp =
    api.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(api.hostname);
  if (
    api.pathname !== "/v1" ||
    api.search ||
    api.hash ||
    api.username ||
    api.password ||
    (api.protocol !== "https:" && !localHttp) ||
    (apiBase.startsWith("/") && apiBase !== "/v1")
  ) {
    throw new Error("证件接口配置无效");
  }
  return apiBase;
}

export function adminIdentityDocumentPath(
  organizationId: string,
  technicianId: string,
  kind: IdentityDocumentKind,
) {
  return `/admin/organizations/${encodeURIComponent(organizationId)}/technician-applications/${encodeURIComponent(technicianId)}/documents/${kind}`;
}

export async function loadPrivateIdentityDocumentPreview(
  apiBaseUrl: string,
  organizationId: string,
  technicianId: string,
  kind: IdentityDocumentKind,
  token: string,
) {
  const apiBase = validatedApiBase(apiBaseUrl);
  const response = await fetch(
    `${apiBase}${adminIdentityDocumentPath(organizationId, technicianId, kind)}`,
    {
      credentials: "omit",
      redirect: "error",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!response.ok) throw new Error("证件未上传或当前账号无权查看");
  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "image/jpeg" && contentType !== "image/png") {
    throw new Error("证件预览格式无效");
  }
  return URL.createObjectURL(await response.blob());
}
