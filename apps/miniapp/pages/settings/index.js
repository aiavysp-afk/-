"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
const customer_center_1 = require("../../utils/customer-center");
Page({
    data: {
        loading: false,
        error: "",
        displayName: "微信用户",
        avatarText: "客",
        registeredAt: "--",
        customerServicePhone: "",
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
            const settings = await (0, api_1.api)((0, customer_center_1.customerCenterPath)("/customer-center/settings"));
            const displayName = settings.displayName || "微信用户";
            this.setData({
                displayName,
                avatarText: displayName.trim().slice(0, 1) || "客",
                registeredAt: settings.registeredAt.slice(0, 10),
                customerServicePhone: settings.customerServicePhone || "",
            });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "设置资料读取失败",
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    openAddresses() {
        wx.navigateTo({ url: "/pages/addresses/index" });
    },
    openSecurity() {
        wx.navigateTo({ url: "/pages/account-security/index" });
    },
    openRecord(event) {
        wx.navigateTo({
            url: `/pages/customer-records/index?kind=${encodeURIComponent(event.currentTarget.dataset.kind)}`,
        });
    },
    clearChat() {
        wx.showModal({
            title: "清空本机聊天展示？",
            content: "只清理本小程序可能保存的本机聊天展示缓存，不会删除微信客服平台、订单、投诉或依法留存的服务记录。",
            confirmText: "清理本机",
            success: (result) => {
                if (!result.confirm)
                    return;
                wx.removeStorageSync("zydj.local-chat-display");
                wx.showToast({ title: "本机展示已清理", icon: "success" });
            },
        });
    },
    callCustomerService() {
        const phone = this.data.customerServicePhone;
        if (!phone) {
            wx.showModal({
                title: "客服电话待配置",
                content: "后台尚未配置客服电话，请先使用微信在线客服。",
                showCancel: false,
            });
            return;
        }
        wx.makePhoneCall({
            phoneNumber: phone,
            fail: () => wx.showToast({ title: "未能拨号，请稍后重试", icon: "none" }),
        });
    },
    async logout() {
        const confirmed = await new Promise((resolve) => wx.showModal({
            title: "退出当前账号？",
            content: "退出后不会删除订单、地址或账户资料，再次登录可继续查看。",
            confirmText: "确认退出",
            success: (result) => resolve(result.confirm === true),
            fail: () => resolve(false),
        }));
        if (!confirmed)
            return;
        try {
            await (0, api_1.api)("/auth/logout", "POST", {});
        }
        catch {
            wx.showToast({ title: "服务端注销未确认，请稍后重试", icon: "none" });
            return;
        }
        (0, auth_1.clearStoredSession)();
        wx.reLaunch({ url: "/pages/home/index" });
    },
});
