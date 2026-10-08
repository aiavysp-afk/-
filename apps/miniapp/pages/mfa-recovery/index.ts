import {
  getStoredSession,
  loginWithWechat,
  requireVerifiedCustomerAccess,
} from "../../utils/auth";
import { api } from "../../utils/api";

type Membership = { organizationId: string; role: string };
type Recovery = {
  id: string;
  organizationId: string;
  organizationName: string | null;
  status: string;
  createdAt: string;
  expiresAt: string;
};

Page({
  data: {
    memberships: [] as Membership[],
    requests: [] as Recovery[],
    busy: false,
    error: "",
  },
  async onLoad() {
    if (!requireVerifiedCustomerAccess()) return;
    await this.refresh();
  },
  async refresh() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      if (!getStoredSession()) await loginWithWechat();
      const [me, requests] = await Promise.all([
        api<{ memberships: Membership[] }>("/auth/me"),
        api<Recovery[]>("/auth/mfa/recovery-requests"),
      ]);
      this.setData({
        memberships: me.memberships.filter((item) => item.role !== "CUSTOMER"),
        requests,
      });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "读取恢复状态失败",
      });
    } finally {
      this.setData({ busy: false });
    }
  },
  async requestRecovery(event: {
    currentTarget: { dataset: { organizationId: string } };
  }) {
    if (this.data.busy) return;
    const organizationId = event.currentTarget.dataset.organizationId;
    const confirmed = await new Promise<boolean>((resolve) =>
      wx.showModal({
        title: "申请重置验证器",
        content:
          "仅在本人丢失验证器时申请。另一名已完成MFA的管理员必须独立复核；批准后你的全部登录会话和旧验证器都会立即失效。",
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      }),
    );
    if (!confirmed) return;
    this.setData({ busy: true, error: "" });
    try {
      await loginWithWechat();
      await api("/auth/mfa/recovery-requests", "POST", { organizationId });
      const requests = await api<Recovery[]>("/auth/mfa/recovery-requests");
      this.setData({ requests });
      wx.showToast({ title: "已提交复核", icon: "success" });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "提交失败",
      });
    } finally {
      this.setData({ busy: false });
    }
  },
  async cancelRecovery(event: {
    currentTarget: { dataset: { requestId: string } };
  }) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      await api(
        `/auth/mfa/recovery-requests/${event.currentTarget.dataset.requestId}/cancel`,
        "POST",
        {},
      );
      const requests = await api<Recovery[]>("/auth/mfa/recovery-requests");
      this.setData({ requests });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "取消失败",
      });
    } finally {
      this.setData({ busy: false });
    }
  },
});
