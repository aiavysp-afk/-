import type {
  PublicConfig,
  ServiceItem,
  TechnicianH5Application,
  TechnicianH5OnboardingStatus,
  TechnicianH5ProfileUpdate,
} from "@zydj/contracts";
import { api } from "../../utils/api";
import {
  getStoredSession,
  requireVerifiedCustomerAccess,
} from "../../utils/auth";
import {
  chooseTechnicianPhoto,
  ownTechnicianPhotoPreview,
} from "../../utils/technician-photos";

const ENTRY = "/pages/technician-onboarding/index";
const BASE = "/technician/onboarding/application";
const DAYS = [
  ["MON", "周一"],
  ["TUE", "周二"],
  ["WED", "周三"],
  ["THU", "周四"],
  ["FRI", "周五"],
  ["SAT", "周六"],
  ["SUN", "周日"],
];
const STANDARD_SLOTS = DAYS.flatMap(([day, label]) => [
  {
    value: `${day}:09:00-18:00`,
    label: `${label} 09:00–18:00`,
    checked: false,
  },
  {
    value: `${day}:18:00-22:00`,
    label: `${label} 18:00–22:00`,
    checked: false,
  },
]);

Page({
  data: {
    loading: false,
    busy: false,
    error: "",
    message: "",
    authorized: false,
    application: null as TechnicianH5Application | null,
    realName: "",
    serviceCity: "",
    serviceAreas: "",
    bio: "",
    serviceIds: [] as string[],
    availableTimeSlots: [] as string[],
    services: [] as (ServiceItem & { checked: boolean })[],
    timeSlots: STANDARD_SLOTS,
    avatarPreview: "",
    galleryPreviews: [] as string[],
    idFrontPreview: "",
    idBackPreview: "",
  },
  async onShow() {
    wx.hideShareMenu?.({ menus: ["shareAppMessage", "shareTimeline"] });
    if (!requireVerifiedCustomerAccess(ENTRY)) return;
    await this.load();
  },
  async load() {
    if (this.data.loading || this.data.busy) return;
    this.setData({ loading: true, error: "" });
    try {
      const [status, services, config] = await Promise.all([
        api<TechnicianH5OnboardingStatus>(
          BASE,
          "GET",
          undefined,
          undefined,
          ENTRY,
        ),
        api<ServiceItem[]>("/catalog/services"),
        api<PublicConfig>("/config/public"),
      ]);
      if (
        !status.application ||
        !["DRAFT", "REJECTED"].includes(status.application.status)
      ) {
        wx.redirectTo({ url: ENTRY });
        return;
      }
      this.setData({
        services: services.map((item) => ({ ...item, checked: false })),
        serviceCity: config.serviceCity,
      });
      await this.showApplication(status.application, true);
    } catch (error) {
      this.setData({
        error:
          error instanceof Error ? error.message : "入驻资料读取失败，请重试",
      });
    } finally {
      this.setData({ loading: false });
    }
  },
  async showApplication(
    application: TechnicianH5Application,
    replaceDraft = false,
  ) {
    this.setData({ application });
    if (replaceDraft) {
      const known = new Set(STANDARD_SLOTS.map((slot) => slot.value));
      const timeSlots = [
        ...STANDARD_SLOTS,
        ...application.availableTimeSlots
          .filter((value) => !known.has(value))
          .map((value) => ({ value, label: value, checked: false })),
      ];
      this.setData({
        realName: application.realName ?? "",
        serviceCity: application.serviceCity || this.data.serviceCity,
        serviceAreas: application.serviceAreas.join("，"),
        bio: application.bio,
        serviceIds: application.serviceIds,
        availableTimeSlots: application.availableTimeSlots,
        services: this.data.services.map((item) => ({
          ...item,
          checked: application.serviceIds.includes(item.id),
        })),
        timeSlots: timeSlots.map((slot) => ({
          ...slot,
          checked: application.availableTimeSlots.includes(slot.value),
        })),
      });
    }
    const userId = getStoredSession()?.user.id;
    if (!userId) throw new Error("微信登录已失效，请重新登录");
    const urls = [application.avatarUrl ?? "", ...application.galleryUrls];
    const previews = await Promise.all(
      urls.map((url) =>
        url ? ownTechnicianPhotoPreview({ technicianId: userId }, url) : "",
      ),
    );
    this.setData({
      avatarPreview: previews[0],
      galleryPreviews: previews.slice(1),
    });
  },
  updateField(event: {
    currentTarget: { dataset: { field: string } };
    detail: { value: string };
  }) {
    const field = event.currentTarget.dataset.field;
    if (["realName", "serviceAreas", "bio"].includes(field))
      this.setData({ [field]: event.detail.value });
  },
  chooseServices(event: { detail: { value: string[] } }) {
    const serviceIds = event.detail.value.filter((id) =>
      this.data.services.some((item) => item.id === id),
    );
    this.setData({
      serviceIds,
      services: this.data.services.map((item) => ({
        ...item,
        checked: serviceIds.includes(item.id),
      })),
    });
  },
  chooseTimes(event: { detail: { value: string[] } }) {
    const availableTimeSlots = event.detail.value.filter((value) =>
      this.data.timeSlots.some((slot) => slot.value === value),
    );
    this.setData({
      availableTimeSlots,
      timeSlots: this.data.timeSlots.map((slot) => ({
        ...slot,
        checked: availableTimeSlots.includes(slot.value),
      })),
    });
  },
  confirmAuthorization(event: { detail: { value: string[] } }) {
    this.setData({ authorized: event.detail.value.includes("authorized") });
  },
  draft(): TechnicianH5ProfileUpdate {
    const realName = this.data.realName.trim();
    const serviceAreas = [
      ...new Set(
        this.data.serviceAreas
          .split(/[，,\n]/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    const bio = this.data.bio.trim();
    if (realName.length < 2 || realName.length > 40)
      throw new Error("请填写2至40字真实姓名");
    if (!this.data.serviceCity) throw new Error("服务城市尚未读取，请刷新页面");
    if (
      !serviceAreas.length ||
      serviceAreas.length > 20 ||
      serviceAreas.some((value) => value.length < 2 || value.length > 40)
    )
      throw new Error("请填写接单区域，用逗号分隔，最多20个");
    if (!this.data.availableTimeSlots.length)
      throw new Error("请选择可接单时间段");
    if (!this.data.serviceIds.length || this.data.serviceIds.length > 20)
      throw new Error("请选择1至20个擅长项目");
    if (bio.length < 10) throw new Error("请填写至少10字真实个人简介");
    return {
      realName,
      serviceCity: this.data.serviceCity,
      serviceAreas,
      availableTimeSlots: this.data.availableTimeSlots,
      bio,
      serviceIds: this.data.serviceIds,
    };
  },
  async save(submit = false) {
    if (
      this.data.busy ||
      !this.data.application ||
      !requireVerifiedCustomerAccess(ENTRY)
    )
      return;
    this.setData({ busy: true, error: "", message: "" });
    try {
      const draft = this.draft();
      if (
        submit &&
        (!this.data.application.avatarUrl ||
          !this.data.application.hasIdFront ||
          !this.data.application.hasIdBack)
      )
        throw new Error("请先上传本人形象照和身份证正反面");
      const saved = await api<TechnicianH5OnboardingStatus>(
        BASE,
        "PATCH",
        draft,
        undefined,
        ENTRY,
      );
      if (saved.application) this.setData({ application: saved.application });
      if (submit) {
        await api<TechnicianH5OnboardingStatus>(
          `${BASE}/submit`,
          "POST",
          {},
          undefined,
          ENTRY,
        );
        wx.redirectTo({ url: ENTRY });
      } else
        this.setData({ message: "资料已保存并同步后台，可继续补充照片和证件" });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "资料保存失败，请重试",
      });
    } finally {
      this.setData({ busy: false });
    }
  },
  saveDraft() {
    return this.save();
  },
  submitReview() {
    return this.save(true);
  },
  async upload(event: {
    currentTarget: {
      dataset: { kind: "AVATAR" | "GALLERY" | "ID_FRONT" | "ID_BACK" };
    };
  }) {
    if (
      this.data.busy ||
      !this.data.application ||
      !requireVerifiedCustomerAccess(ENTRY)
    )
      return;
    if (!this.data.authorized) {
      wx.showToast({ title: "请先确认本人资料及照片授权", icon: "none" });
      return;
    }
    const kind = event.currentTarget.dataset.kind;
    if (!["AVATAR", "GALLERY", "ID_FRONT", "ID_BACK"].includes(kind)) return;
    this.setData({ busy: true, error: "", message: "" });
    try {
      const selected = await chooseTechnicianPhoto();
      const isDocument = kind === "ID_FRONT" || kind === "ID_BACK";
      const status = await api<TechnicianH5OnboardingStatus>(
        `${BASE}/${isDocument ? "documents" : "photos"}`,
        "POST",
        {
          kind,
          contentBase64: selected.base64,
          ...(!isDocument ? { consentConfirmed: true } : {}),
        },
        undefined,
        ENTRY,
      );
      if (status.application) await this.showApplication(status.application);
      if (kind === "ID_FRONT") this.setData({ idFrontPreview: selected.path });
      if (kind === "ID_BACK") this.setData({ idBackPreview: selected.path });
      this.setData({
        message: isDocument
          ? "证件已安全保存，仅用于本人入驻审核"
          : "形象照已保存并同步后台，审核发布后展示",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "上传失败，请重试";
      if (message !== "已取消选择") this.setData({ error: message });
    } finally {
      this.setData({ busy: false });
    }
  },
  preview(event: { currentTarget: { dataset: { url: string } } }) {
    const current = event.currentTarget.dataset.url;
    if (current) wx.previewImage({ current, urls: [current] });
  },
});
