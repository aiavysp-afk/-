import {
  getStoredSession,
  loginWithWechat,
  requireVerifiedCustomerAccess,
} from "../../utils/auth";
import { api } from "../../utils/api";
type Preview = { audience: string; expiresAt: string; provider: string };
Page({
  data: {
    pairCode: "",
    confirmationCode: "",
    busy: false,
    error: "",
    preview: null as Preview | null,
    approved: false,
  },
  sourceToken: "",
  onLoad() {
    requireVerifiedCustomerAccess();
  },
  onPairInput(event: { detail: { value: string } }) {
    this.sourceToken = "";
    this.setData({
      pairCode: event.detail.value.trim(),
      preview: null,
      approved: false,
      error: "",
    });
  },
  onCodeInput(event: { detail: { value: string } }) {
    this.setData({
      confirmationCode: event.detail.value.replace(/\D/g, "").slice(0, 6),
    });
  },
  async inspect() {
    if (this.data.busy) return;
    this.sourceToken = "";
    this.setData({
      busy: true,
      error: "",
      preview: null,
      approved: false,
      confirmationCode: "",
    });
    try {
      if (!/^[A-Za-z0-9_-]{22}$/.test(this.data.pairCode))
        throw Error("请输入自己电脑显示的22位配对码");
      const session = await loginWithWechat();
      const preview = await api<Preview>(
        "/auth/browser-login/inspect",
        "POST",
        { pairCode: this.data.pairCode },
      );
      this.sourceToken = session.accessToken;
      this.setData({ preview });
    } catch (e) {
      this.setData({ error: e instanceof Error ? e.message : "登录核验失败" });
    } finally {
      this.setData({ busy: false });
    }
  },
  async approve() {
    if (this.data.busy || !this.data.preview || this.data.approved) return;
    if (!/^\d{6}$/.test(this.data.confirmationCode)) {
      this.setData({ error: "请输入电脑显示的六位核对数字" });
      return;
    }
    this.setData({ busy: true, error: "" });
    try {
      const confirmed = await new Promise<boolean>((resolve) =>
        wx.showModal({
          title: "确认是你自己的电脑",
          content: `即将授权${this.data.preview!.audience}登录。仅确认本人主动发起的请求，不接受客服或陌生人提供的配对码；电脑还须独立完成MFA。`,
          success: (r) => resolve(r.confirm),
          fail: () => resolve(false),
        }),
      );
      if (!confirmed) return;
      if (getStoredSession()?.accessToken !== this.sourceToken)
        throw Error("微信会话已变化，请重新读取并核验");
      await api("/auth/browser-login/approve", "POST", {
        pairCode: this.data.pairCode,
        confirmationCode: this.data.confirmationCode,
      });
      this.sourceToken = "";
      this.setData({ approved: true, confirmationCode: "", preview: null });
    } catch (e) {
      this.setData({ error: e instanceof Error ? e.message : "确认失败" });
    } finally {
      this.setData({ busy: false });
    }
  },
  onUnload() {
    this.sourceToken = "";
  },
});
