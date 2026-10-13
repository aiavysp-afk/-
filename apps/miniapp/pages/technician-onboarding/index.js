"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
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
        application: null,
        statusLabel: "",
    },
    async onShow() {
        var _a;
        (_a = wx.showShareMenu) === null || _a === void 0 ? void 0 : _a.call(wx, { menus: ["shareAppMessage"] });
        if (!(0, auth_1.requireVerifiedCustomerAccess)(ENTRY))
            return;
        await this.load();
    },
    async load() {
        var _a;
        if (this.data.busy)
            return;
        this.setData({ busy: true, error: "" });
        try {
            let application = await (0, api_1.api)("/technician/onboarding", "GET", undefined, undefined, ENTRY);
            const firstRegistration = !application.profile;
            if (!application.profile)
                application = await (0, api_1.api)("/technician/onboarding", "POST", {}, undefined, ENTRY);
            this.setData({
                application,
                statusLabel: application.profile
                    ? labels[application.profile.status]
                    : "填写入驻资料",
            });
            if (application.canEnterWorkbench)
                wx.redirectTo({ url: "/pages/technician-workbench/index" });
            else if (firstRegistration && ((_a = application.profile) === null || _a === void 0 ? void 0 : _a.status) === "DRAFT")
                wx.redirectTo({ url: "/pages/technician-application/index" });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "入驻状态读取失败，请重试",
            });
        }
        finally {
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
