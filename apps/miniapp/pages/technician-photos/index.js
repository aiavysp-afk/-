"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
const technician_photos_1 = require("../../utils/technician-photos");
const statusLabels = { DRAFT: "草稿", PENDING_REVIEW: "待后台审核", APPROVED: "待发布", PUBLISHED: "已公开", REJECTED: "待修改" };
Page({
    data: { profile: null, avatarPreview: "", galleryPreviews: [], introduction: "", specialties: "", loading: false, busy: false, authorized: false, error: "", message: "", statusLabel: "" },
    async onShow() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        // The API validates current membership, including newly claimed invitations.
        await this.load();
    },
    back() { wx.navigateBack({ delta: 1 }); },
    async load() {
        if (this.data.loading)
            return;
        this.setData({ loading: true, error: "" });
        try {
            await this.showProfile(await (0, api_1.api)("/technician/workbench/profile"));
        }
        catch (error) {
            this.setData({ profile: null, error: error instanceof Error ? error.message : "此入口仅供已入驻的本人技师使用，普通客户不能替其他技师上传照片" });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    async showProfile(profile) {
        var _a;
        this.setData({ profile, statusLabel: statusLabels[profile.status], introduction: profile.introduction, specialties: profile.specialties.join("，") });
        const previews = await Promise.all([(_a = profile.avatarUrl) !== null && _a !== void 0 ? _a : "", ...profile.galleryUrls].map(async (url) => {
            if (!url)
                return "";
            return (0, technician_photos_1.ownTechnicianPhotoPreview)(profile, url);
        }));
        this.setData({ avatarPreview: previews[0], galleryPreviews: previews.slice(1) });
    },
    onAuthorization(event) { this.setData({ authorized: event.detail.value.includes("authorized") }); },
    onIntroduction(event) { this.setData({ introduction: event.detail.value }); },
    onSpecialties(event) { this.setData({ specialties: event.detail.value }); },
    async submitReview() {
        if (this.data.busy || !this.data.profile || !(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        const introduction = this.data.introduction.trim();
        const specialties = [...new Set(this.data.specialties.split(/[，,\n]/).map((value) => value.trim()).filter(Boolean))];
        if (!this.data.profile.avatarUrl || !introduction || !specialties.length) {
            wx.showToast({ title: "照片可先保留，审核前请补充真实介绍和擅长", icon: "none" });
            return;
        }
        this.setData({ busy: true, error: "", message: "" });
        try {
            await (0, api_1.api)("/technician/workbench/profile", "PATCH", { introduction, specialties });
            const profile = await (0, api_1.api)("/technician/workbench/profile/submit-review", "POST", {});
            await this.showProfile(profile);
            this.setData({ message: "已提交管理后台审核，审核通过并发布后才会公开；不会自动开通接单资格" });
        }
        catch (error) {
            this.setData({ error: error instanceof Error ? error.message : "提交审核失败，请重试" });
        }
        finally {
            this.setData({ busy: false });
        }
    },
    async upload(event) {
        if (this.data.busy || !this.data.profile || !(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        if (!this.data.authorized) {
            wx.showToast({ title: "请先确认本人照片授权", icon: "none" });
            return;
        }
        this.setData({ busy: true, error: "", message: "" });
        try {
            const selected = await (0, technician_photos_1.chooseTechnicianPhoto)();
            const result = await (0, api_1.api)("/technician/workbench/profile/photos", "POST", { kind: event.currentTarget.dataset.kind, base64: selected.base64, authorized: true });
            this.setData({ message: "照片已保存并同步管理后台，审核发布后展示在客户端卡片和详情；姓名、年龄段可由后台后续补录" });
            await this.showProfile(result.profile);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "上传失败，请稍后重试";
            if (message !== "已取消选择")
                this.setData({ error: message });
        }
        finally {
            this.setData({ busy: false });
        }
    },
    preview(event) {
        const urls = [this.data.avatarPreview, ...this.data.galleryPreviews].filter(Boolean);
        if (urls.length)
            wx.previewImage({ current: event.currentTarget.dataset.url, urls });
    },
});
