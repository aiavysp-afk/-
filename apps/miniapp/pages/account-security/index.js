"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
const customer_center_1 = require("../../utils/customer-center");
const statusLabels = {
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
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        await this.load();
    },
    async load() {
        this.setData({ loading: true, error: "" });
        try {
            const [settings, request] = await Promise.all([
                (0, api_1.api)((0, customer_center_1.customerCenterPath)("/customer-center/settings")),
                (0, api_1.api)((0, customer_center_1.customerCenterPath)("/customer-center/account-deletion")),
            ]);
            this.setData({
                maskedPhone: settings.maskedPhone || "未绑定",
                phoneVerified: settings.phoneVerified,
                requestStatus: request ? statusLabels[request.status] : "",
                requestTime: request ? (0, api_1.shanghaiTime)(request.createdAt) : "",
            });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "账号安全资料读取失败",
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    async requestDeletion() {
        if (this.data.busy || this.data.requestStatus === "审核处理中")
            return;
        const confirmed = await new Promise((resolve) => wx.showModal({
            title: "申请注销账号",
            content: "注销可能影响订单售后、优惠权益和余额使用。平台会先审核未完成订单、退款及依法留存事项；提交申请不会立即硬删除数据，完成后不可恢复。",
            confirmText: "已了解并申请",
            success: (result) => resolve(result.confirm === true),
            fail: () => resolve(false),
        }));
        if (!confirmed)
            return;
        this.setData({ busy: true, error: "" });
        try {
            const organizationId = (0, customer_center_1.getCustomerCenterOrganizationId)();
            const payload = {
                ...(organizationId ? { organizationId } : {}),
                reason: "用户从微信小程序账号与安全页发起",
                acknowledgedRisk: true,
            };
            const request = await (0, api_1.api)("/customer-center/account-deletion", "POST", payload, (0, api_1.newKey)());
            this.setData({
                requestStatus: statusLabels[request.status],
                requestTime: (0, api_1.shanghaiTime)(request.createdAt),
            });
            wx.showModal({
                title: "申请已提交",
                content: "后台已收到注销申请。申请期间账号不会立即删除，请留意平台审核结果；如有未完成订单，请先处理售后。",
                showCancel: false,
            });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "注销申请提交失败",
            });
        }
        finally {
            this.setData({ busy: false });
        }
    },
});
