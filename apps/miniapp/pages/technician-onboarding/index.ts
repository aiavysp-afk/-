import type { TechnicianInvitationClaimed } from "@zydj/contracts";
import { api } from "../../utils/api";
import { requireVerifiedCustomerAccess } from "../../utils/auth";

Page({
  data: {
    code: "",
    busy: false,
    error: "",
    result: null as TechnicianInvitationClaimed | null,
  },
  onLoad(options: { code?: string }) {
    if (!requireVerifiedCustomerAccess()) return;
    const code = String(options.code ?? "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, "")
      .slice(0, 12);
    this.setData({ code });
  },
  onCodeInput(event: { detail: { value: string } }) {
    this.setData({
      code: event.detail.value
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, "")
        .slice(0, 12),
      error: "",
    });
  },
  async claim() {
    if (this.data.busy || this.data.result) return;
    if (!/^[A-Z0-9_-]{12}$/.test(this.data.code)) {
      this.setData({ error: "请输入后台发放的12位技师邀请码" });
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) =>
      wx.showModal({
        title: "确认认领技师身份？",
        content:
          "邀请码只能由本人微信账号使用一次。认领后仍需填写本人资料，并经平台核验、审核和发布后才会向客户展示。",
        confirmText: "本人认领",
        success: (result) => resolve(result.confirm === true),
        fail: () => resolve(false),
      }),
    );
    if (!confirmed) return;
    this.setData({ busy: true, error: "" });
    try {
      const result = await api<TechnicianInvitationClaimed>(
        "/technician-invitations/claim",
        "POST",
        { code: this.data.code },
      );
      this.setData({ result, code: "" });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "技师身份认领失败",
      });
    } finally {
      this.setData({ busy: false });
    }
  },
  copyWorkbenchAddress() {
    wx.setClipboardData({
      data: "https://mtsc.top/technician/",
      success: () =>
        wx.showToast({ title: "技师端地址已复制", icon: "success" }),
    });
  },
  openStaffLoginConfirmation() {
    wx.navigateTo({ url: "/pages/admin-login/index" });
  },
});
