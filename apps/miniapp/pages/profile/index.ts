import {
  clearStoredSession,
  getStoredSession,
  loginWithWechat,
} from "../../utils/auth";
import { api } from "../../utils/api";

Page({
  data: {
    menus: [
      "我的地址",
      "优惠券",
      "发票申请",
      "联系客服",
      "协议与隐私",
      "账户与安全",
    ],
    loggedIn: false,
    loggingIn: false,
    displayName: "微信用户",
  },
  onLoad() {
    const session = getStoredSession();
    if (session)
      this.setData({ loggedIn: true, displayName: session.user.displayName });
  },
  async login() {
    if (this.data.loggingIn) return;
    this.setData({ loggingIn: true });
    try {
      const session = await loginWithWechat();
      this.setData({
        loggedIn: true,
        loggingIn: false,
        displayName: session.user.displayName,
      });
      wx.showToast({ title: "登录成功", icon: "success" });
    } catch (error) {
      this.setData({ loggingIn: false });
      wx.showToast({
        title: error instanceof Error ? error.message : "登录失败",
        icon: "none",
      });
    }
  },
  async logout() {
    try {
      await api("/auth/logout", "POST", {});
    } catch {
      wx.showToast({ title: "服务端注销未确认，请稍后重试", icon: "none" });
      return;
    }
    clearStoredSession();
    this.setData({ loggedIn: false, displayName: "微信用户" });
    wx.showToast({ title: "会话已安全注销", icon: "success" });
  },
});
