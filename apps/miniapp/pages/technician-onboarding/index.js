"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("../../utils/auth");
const ENTRY = "/pages/technician-onboarding/index";
const labels = {
    DRAFT: "填写入驻资料",
    PENDING_REVIEW: "入驻资料审核中",
    APPROVED: "审核通过",
    PUBLISHED: "审核通过",
    REJECTED: "请修改后重新提交",
};
const verifiedWechatSession = () => {
    const session = (0, auth_1.getStoredSession)();
    return (session === null || session === void 0 ? void 0 : session.loginMethod) === "WECHAT" &&
        session.user.phoneVerified === true
        ? session
        : undefined;
};
// Expired technician sessions remain on this dedicated login page. The generic
// customer helper redirects 401 responses to the customer login screen.
function onboardingRequest(token, method) {
    const base = getApp().globalData
        .apiBaseUrl;
    return new Promise((resolve, reject) => {
        wx.request({
            url: `${base}/technician/onboarding`,
            method,
            timeout: 15000,
            ...(method === "POST" ? { data: {} } : {}),
            header: {
                Authorization: `Bearer ${token}`,
                "content-type": method === "POST" ? "application/json" : "text/plain",
            },
            success(response) {
                if (response.statusCode === 200 && response.data.data) {
                    resolve(response.data.data);
                    return;
                }
                reject(Object.assign(new Error(response.data.message || "入驻状态读取失败，请重试"), {
                    status: response.statusCode,
                }));
            },
            fail: () => reject(new Error("网络连接暂时异常，请检查网络后重试")),
        });
    });
}
Page({
    disposed: false,
    generation: 0,
    capabilitiesRequest: null,
    data: {
        accepted: false,
        authenticated: false,
        busy: false,
        capabilitiesLoading: false,
        capabilitiesReady: false,
        wechatPhoneLoginEnabled: false,
        error: "",
        application: null,
        statusLabel: "",
    },
    async onShow() {
        var _a;
        (_a = wx.showShareMenu) === null || _a === void 0 ? void 0 : _a.call(wx, { menus: ["shareAppMessage"] });
        if (this.data.busy)
            return;
        const session = verifiedWechatSession();
        this.setData({ authenticated: Boolean(session) });
        if (session)
            await this.load();
        else {
            this.setData({ application: null, statusLabel: "" });
            await this.loadCapabilities();
        }
    },
    onUnload() {
        this.disposed = true;
        this.generation++;
    },
    async loadCapabilities() {
        if (this.disposed || this.data.busy)
            return;
        if (this.capabilitiesRequest)
            return this.capabilitiesRequest;
        this.setData({
            capabilitiesLoading: true,
            capabilitiesReady: false,
            error: "",
        });
        const request = (async () => {
            try {
                const capabilities = await (0, auth_1.getCustomerLoginCapabilities)();
                if (this.disposed)
                    return;
                this.setData({
                    capabilitiesReady: true,
                    wechatPhoneLoginEnabled: capabilities.wechatPhoneLoginEnabled === true,
                    error: capabilities.wechatPhoneLoginEnabled
                        ? ""
                        : "微信授权登录暂未就绪，请稍后重试或联系平台客服",
                });
            }
            catch {
                if (!this.disposed)
                    this.setData({
                        capabilitiesReady: true,
                        wechatPhoneLoginEnabled: false,
                        error: "登录服务状态读取失败，请重试",
                    });
            }
            finally {
                if (!this.disposed)
                    this.setData({ capabilitiesLoading: false });
            }
        })();
        this.capabilitiesRequest = request;
        try {
            await request;
        }
        finally {
            if (this.capabilitiesRequest === request)
                this.capabilitiesRequest = null;
        }
    },
    toggleAccepted() {
        if (!this.data.busy)
            this.setData({ accepted: !this.data.accepted, error: "" });
    },
    openAgreement(event) {
        const type = event.currentTarget.dataset.type;
        if (type && ["user", "privacy", "service"].includes(type)) {
            wx.navigateTo({ url: `/pages/agreement/index?type=${type}` });
        }
    },
    handleWechatChoice() {
        if (this.data.busy)
            return;
        if (!this.data.accepted)
            this.setData({ error: "请先阅读并同意用户协议、隐私政策与上门服务公约" });
        else if (!this.data.capabilitiesReady || !this.data.wechatPhoneLoginEnabled)
            this.setData({ error: "微信授权登录暂未就绪，请点击重新连接" });
    },
    async authorizeWechat(event) {
        var _a;
        if (this.data.busy || this.disposed)
            return;
        if (!this.data.accepted ||
            !this.data.capabilitiesReady ||
            !this.data.wechatPhoneLoginEnabled) {
            this.handleWechatChoice();
            return;
        }
        const code = (_a = event.detail.code) === null || _a === void 0 ? void 0 : _a.trim();
        if (!code) {
            this.setData({
                error: /deny|cancel/i.test(event.detail.errMsg || "")
                    ? "你已取消微信授权，资料尚未创建，可再次点击授权登录"
                    : "未取得微信手机号授权，请重新点击授权登录",
            });
            return;
        }
        const attempt = ++this.generation;
        this.setData({ busy: true, error: "", application: null, statusLabel: "" });
        let token = "";
        try {
            // The atomic server login preserves the existing WeChat/verified-phone
            // owner and safely attaches a first WeChat identity to a phone applicant.
            const session = await (0, auth_1.loginCustomerWithWechatPhone)(code, this.data.accepted);
            if (this.disposed || attempt !== this.generation)
                return;
            token = session.accessToken;
            const verified = verifiedWechatSession();
            if (!verified || verified.accessToken !== token)
                throw new Error("微信身份验证尚未完成，请重新点击授权登录");
            this.setData({ authenticated: true });
            await this.readApplication(token, attempt);
        }
        catch (error) {
            this.showFailure(error, token, attempt);
        }
        finally {
            if (!this.disposed && attempt === this.generation)
                this.setData({ busy: false });
        }
    },
    async load() {
        if (this.data.busy || this.disposed)
            return;
        const session = verifiedWechatSession();
        if (!session) {
            this.setData({
                authenticated: false,
                application: null,
                statusLabel: "",
            });
            await this.loadCapabilities();
            return;
        }
        const attempt = ++this.generation;
        this.setData({ busy: true, error: "", application: null, statusLabel: "" });
        try {
            await this.readApplication(session.accessToken, attempt);
        }
        catch (error) {
            this.showFailure(error, session.accessToken, attempt);
        }
        finally {
            if (!this.disposed && attempt === this.generation)
                this.setData({ busy: false });
        }
    },
    async readApplication(token, attempt) {
        var _a, _b;
        const current = () => {
            var _a;
            return !this.disposed &&
                attempt === this.generation &&
                ((_a = verifiedWechatSession()) === null || _a === void 0 ? void 0 : _a.accessToken) === token;
        };
        let application = await onboardingRequest(token, "GET");
        if (!current())
            return;
        if (!application.phoneVerified)
            throw Object.assign(new Error("本人手机号验证未完成，请重新点击微信授权登录"), { status: 401 });
        if (!application.profile) {
            application = await onboardingRequest(token, "POST");
            if (!current())
                return;
            if (!application.profile || !application.phoneVerified) {
                throw new Error("入驻资料尚未准备完成，请点击刷新重试");
            }
        }
        this.setData({
            authenticated: true,
            application,
            statusLabel: application.profile
                ? labels[application.profile.status]
                : "填写入驻资料",
        });
        if (application.canEnterWorkbench) {
            wx.redirectTo({ url: "/pages/technician-workbench/index" });
        }
        else if (((_a = application.profile) === null || _a === void 0 ? void 0 : _a.status) === "DRAFT" ||
            ((_b = application.profile) === null || _b === void 0 ? void 0 : _b.status) === "REJECTED") {
            wx.redirectTo({ url: "/pages/technician-application/index" });
        }
    },
    showFailure(error, token, attempt) {
        var _a;
        if (this.disposed || attempt !== this.generation)
            return;
        if ((error === null || error === void 0 ? void 0 : error.status) === 401 &&
            ((_a = (0, auth_1.getStoredSession)()) === null || _a === void 0 ? void 0 : _a.accessToken) === token) {
            (0, auth_1.clearStoredSession)();
            this.setData({
                authenticated: false,
                application: null,
                statusLabel: "",
                capabilitiesReady: false,
            });
        }
        else if (!verifiedWechatSession()) {
            this.setData({
                authenticated: false,
                application: null,
                statusLabel: "",
            });
        }
        this.setData({
            error: error instanceof Error ? error.message : "微信登录未完成，请重试",
        });
    },
    editProfile() {
        var _a, _b, _c;
        if (!verifiedWechatSession() ||
            this.data.busy ||
            !["DRAFT", "REJECTED"].includes((_c = (_b = (_a = this.data.application) === null || _a === void 0 ? void 0 : _a.profile) === null || _b === void 0 ? void 0 : _b.status) !== null && _c !== void 0 ? _c : ""))
            return;
        wx.navigateTo({ url: "/pages/technician-application/index" });
    },
    onShareAppMessage() {
        return { title: "中原到家 · 技师微信入驻", path: ENTRY };
    },
});
