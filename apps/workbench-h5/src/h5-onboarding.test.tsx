import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OnboardingProfileFields } from "./h5-onboarding-page";
import {
  draftFromApplication,
  h5OnboardingPaths,
  isConfigurationUnavailableRoute,
  isOnboardingRoute,
  normalizeList,
  parseWechatCallbackTicket,
  validateOnboardingDraft,
  type H5OnboardingDraft,
} from "./h5-onboarding";

const completeDraft: H5OnboardingDraft = {
  realName: "测试技师",
  serviceCity: "郑州市",
  serviceAreas: ["金水区", "郑东新区"],
  availableTimeSlots: ["MON:09:00-12:00"],
  bio: "本人擅长肩颈舒缓以及中式推拿服务。",
  serviceIds: ["service-1"],
};

describe("independent technician H5 onboarding", () => {
  it("uses a separate API namespace and the existing passwordless SMS endpoints", () => {
    expect(h5OnboardingPaths()).toEqual({
      wechatStart: "/technician/h5-onboarding/wechat/start",
      wechatExchange: "/technician/h5-onboarding/wechat/exchange",
      smsRequest: "/auth/sms-phone/request",
      smsConfirm: "/auth/sms-phone/confirm",
      status: "/technician/h5-onboarding/status",
      register: "/technician/h5-onboarding/register",
      profile: "/technician/h5-onboarding/profile",
      photos: "/technician/h5-onboarding/photos",
      documents: "/technician/h5-onboarding/documents",
      submit: "/technician/h5-onboarding/submit",
      catalog: "/catalog/services",
    });
  });

  it("accepts only the dedicated onboarding path and a strict one-time OAuth ticket", () => {
    expect(isOnboardingRoute("/technician/onboarding/")).toBe(true);
    expect(isOnboardingRoute("/technician/", "#/wechat-callback?ticket=ABCDEFGH")).toBe(true);
    expect(isOnboardingRoute("/technician/profile")).toBe(false);
    expect(parseWechatCallbackTicket("#/wechat-callback?ticket=valid_ticket-12345678901234567890")).toBe("valid_ticket-12345678901234567890");
    expect(parseWechatCallbackTicket("#/wechat-callback?ticket=https%3A%2F%2Fevil.invalid")).toBeNull();
    expect(parseWechatCallbackTicket("#/wechat-callback?ticket=short")).toBeNull();
  });

  it("recognizes only the fixed configuration unavailable callback state", () => {
    expect(isConfigurationUnavailableRoute("#/configuration-unavailable")).toBe(true);
    expect(isConfigurationUnavailableRoute("#/configuration-unavailable?next=https://evil.invalid")).toBe(false);
    expect(isConfigurationUnavailableRoute("#/wechat-callback")).toBe(false);
  });

  it("normalizes areas and blocks incomplete applications before uploads", () => {
    expect(normalizeList("金水区， 郑东新区,金水区\n二七区")).toEqual(["金水区", "郑东新区", "二七区"]);
    expect(validateOnboardingDraft(completeDraft)).toBe("");
    expect(validateOnboardingDraft({ ...completeDraft, realName: "王" })).toContain("真实姓名");
    expect(validateOnboardingDraft({ ...completeDraft, serviceAreas: [] })).toContain("接单区域");
    expect(validateOnboardingDraft({ ...completeDraft, availableTimeSlots: [] })).toContain("时间段");
    expect(validateOnboardingDraft({ ...completeDraft, serviceIds: [] })).toContain("擅长项目");
  });

  it("restores editable fields without exposing identity document URLs", () => {
    expect(draftFromApplication({
      id: "application-1",
      status: "REJECTED",
      realName: "测试技师",
      serviceCity: "郑州市",
      serviceAreas: ["金水区"],
      availableTimeSlots: ["MON:09:00-12:00"],
      bio: "这是已经同步到后台的个人介绍。",
      serviceIds: ["service-1"],
      avatarUrl: null,
      galleryUrls: [],
      hasIdFront: true,
      hasIdBack: true,
      rejectionReason: "请补充清晰照片",
      updatedAt: "2026-10-12T00:00:00.000Z",
      version: 1,
    })).toEqual({
      realName: "测试技师",
      serviceCity: "郑州市",
      serviceAreas: ["金水区"],
      availableTimeSlots: ["MON:09:00-12:00"],
      bio: "这是已经同步到后台的个人介绍。",
      serviceIds: ["service-1"],
    });
  });

  it("renders every required profile field and server-provided service choices", () => {
    const markup = renderToStaticMarkup(
      <OnboardingProfileFields
        draft={completeDraft}
        services={[{ id: "service-1", name: "中式推拿", durationMinutes: 60 }]}
        onChange={vi.fn()}
      />,
    );
    expect(markup).toContain("真实姓名");
    expect(markup).toContain("服务城市");
    expect(markup).toContain("接单区域");
    expect(markup).toContain("可接单时间段");
    expect(markup).toContain("个人简介");
    expect(markup).toContain("擅长项目（多选）");
    expect(markup).toContain("中式推拿 · 60分钟");
    expect(markup).toContain('type="checkbox"');
  });
});
