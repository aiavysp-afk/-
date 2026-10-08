"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("../../utils/auth");
const api_1 = require("../../utils/api");
Page({
    data: {
        memberships: [],
        requests: [],
        busy: false,
        error: "",
    },
    async onLoad() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        await this.refresh();
    },
    async refresh() {
        if (this.data.busy)
            return;
        this.setData({ busy: true, error: "" });
        try {
            if (!(0, auth_1.getStoredSession)())
                await (0, auth_1.loginWithWechat)();
            const [me, requests] = await Promise.all([
                (0, api_1.api)("/auth/me"),
                (0, api_1.api)("/auth/mfa/recovery-requests"),
            ]);
            this.setData({
                memberships: me.memberships.filter((item) => item.role !== "CUSTOMER"),
                requests,
            });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "读取恢复状态失败",
            });
        }
        finally {
            this.setData({ busy: false });
        }
    },
    async requestRecovery(event) {
        if (this.data.busy)
            return;
        const organizationId = event.currentTarget.dataset.organizationId;
        const confirmed = await new Promise((resolve) => wx.showModal({
            title: "申请重置验证器",
            content: "仅在本人丢失验证器时申请。另一名已完成MFA的管理员必须独立复核；批准后你的全部登录会话和旧验证器都会立即失效。",
            success: (result) => resolve(result.confirm),
            fail: () => resolve(false),
        }));
        if (!confirmed)
            return;
        this.setData({ busy: true, error: "" });
        try {
            await (0, auth_1.loginWithWechat)();
            await (0, api_1.api)("/auth/mfa/recovery-requests", "POST", { organizationId });
            const requests = await (0, api_1.api)("/auth/mfa/recovery-requests");
            this.setData({ requests });
            wx.showToast({ title: "已提交复核", icon: "success" });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "提交失败",
            });
        }
        finally {
            this.setData({ busy: false });
        }
    },
    async cancelRecovery(event) {
        if (this.data.busy)
            return;
        this.setData({ busy: true, error: "" });
        try {
            await (0, api_1.api)(`/auth/mfa/recovery-requests/${event.currentTarget.dataset.requestId}/cancel`, "POST", {});
            const requests = await (0, api_1.api)("/auth/mfa/recovery-requests");
            this.setData({ requests });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "取消失败",
            });
        }
        finally {
            this.setData({ busy: false });
        }
    },
});
