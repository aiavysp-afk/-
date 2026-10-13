import type { TechnicianOnboarding } from "@zydj/contracts";
import { api } from "../../utils/api";
import { requireVerifiedCustomerAccess } from "../../utils/auth";

const ENTRY = "/pages/technician-onboarding/index";
const labels = {
  DRAFT: "填写入驻资料",
  PENDING_REVIEW: "入驻资料审核中",
  APPROVED: "审核通过",
  PUBLISHED: "审核通过",
  REJECTED: "请修改后重新提交",
};
Page({
  data: {
    busy: false,
    error: "",
    application: null as TechnicianOnboarding | null,
    statusLabel: "",
  },
  async onShow() {
    wx.showShareMenu?.({ menus: ["shareAppMessage"] });
    if (!requireVerifiedCustomerAccess(ENTRY)) return;
    await this.load();
  },
  async load() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      let application = await api<TechnicianOnboarding>(
        "/technician/onboarding",
        "GET",
        undefined,
        undefined,
        ENTRY,
      );
      const firstRegistration = !application.profile;
      if (!application.profile)
        application = await api<TechnicianOnboarding>(
          "/technician/onboarding",
          "POST",
          {},
          undefined,
          ENTRY,
        );
      this.setData({
        application,
        statusLabel: application.profile
          ? labels[application.profile.status]
          : "填写入驻资料",
      });
      if (application.canEnterWorkbench)
        wx.redirectTo({ url: "/pages/technician-workbench/index" });
      else if (firstRegistration && application.profile?.status === "DRAFT")
        wx.redirectTo({ url: "/pages/technician-application/index" });
    } catch (error) {
      this.setData({
        error:
          error instanceof Error ? error.message : "入驻状态读取失败，请重试",
      });
    } finally {
      this.setData({ busy: false });
    }
  },
  editProfile() {
    wx.navigateTo({ url: "/pages/technician-application/index" });
  },
  onShareAppMessage() {
    return { title: "中原到家 · 技师微信入驻", path: ENTRY };
  },
});
