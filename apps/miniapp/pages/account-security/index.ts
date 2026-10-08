import type {
  AccountDeletionRequest,
  AccountDeletionRequestCreate,
  CustomerSettings,
} from "@zydj/contracts";
import { api, newKey, shanghaiTime } from "../../utils/api";
import { requireVerifiedCustomerAccess } from "../../utils/auth";
import {
  customerCenterPath,
  getCustomerCenterOrganizationId,
} from "../../utils/customer-center";

const statusLabels: Record<AccountDeletionRequest["status"], string> = {
  PENDING: "审核处理中",
  CANCELLED: "已取消",
  COMPLETED: "已完成",
};

Page({
  data: {
    maskedPhone: "未绑定",
    phoneVerified: false,
    requestStatus: "",
    requestTime: "",
    loading: false,
    busy: false,
    error: "",
  },
  back() {
    wx.navigateBack({ delta: 1 });
  },
  async onShow() {
    if (!requireVerifiedCustomerAccess()) return;
    await this.load();
  },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const [settings, request] = await Promise.all([
        api<CustomerSettings>(customerCenterPath("/customer-center/settings")),
        api<AccountDeletionRequest | null>(
          customerCenterPath("/customer-center/account-deletion"),
        ),
      ]);
      this.setData({
        maskedPhone: settings.maskedPhone || "未绑定",
        phoneVerified: settings.phoneVerified,
        requestStatus: request ? statusLabels[request.status] : "",
        requestTime: request ? shanghaiTime(request.createdAt) : "",
      });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "账号安全资料读取失败",
      });
    } finally {
      this.setData({ loading: false });
    }
  },
  async requestDeletion() {
    if (this.data.busy || this.data.requestStatus === "审核处理中") return;
    const confirmed = await new Promise<boolean>((resolve) =>
      wx.showModal({
        title: "申请注销账号",
        content:
          "注销可能影响订单售后、优惠权益和余额使用。平台会先审核未完成订单、退款及依法留存事项；提交申请不会立即硬删除数据，完成后不可恢复。",
        confirmText: "已了解并申请",
        success: (result) => resolve(result.confirm === true),
        fail: () => resolve(false),
      }),
    );
    if (!confirmed) return;
    this.setData({ busy: true, error: "" });
    try {
      const organizationId = getCustomerCenterOrganizationId();
      const payload: AccountDeletionRequestCreate = {
        ...(organizationId ? { organizationId } : {}),
        reason: "用户从微信小程序账号与安全页发起",
        acknowledgedRisk: true,
      };
      const request = await api<AccountDeletionRequest>(
        "/customer-center/account-deletion",
        "POST",
        payload,
        newKey(),
      );
      this.setData({
        requestStatus: statusLabels[request.status],
        requestTime: shanghaiTime(request.createdAt),
      });
      wx.showModal({
        title: "申请已提交",
        content:
          "后台已收到注销申请。申请期间账号不会立即删除，请留意平台审核结果；如有未完成订单，请先处理售后。",
        showCancel: false,
      });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "注销申请提交失败",
      });
    } finally {
      this.setData({ busy: false });
    }
  },
});
