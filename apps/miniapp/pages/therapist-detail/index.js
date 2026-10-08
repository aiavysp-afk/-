"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const therapists_1 = require("../../utils/therapists");
const auth_1 = require("../../utils/auth");
Page({
    data: {
        error: "",
        loading: true,
        therapist: null,
    },
    async onLoad(options) {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        if (!options.id) {
            this.setData({ error: "缺少技师参数", loading: false });
            return;
        }
        try {
            const therapists = await (0, therapists_1.loadPublicTherapists)();
            const therapist = therapists.find((item) => item.id === options.id);
            if (!therapist)
                throw new Error("该技师当前没有公开可约排班");
            this.setData({ therapist });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "技师资料读取失败",
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    back() {
        wx.navigateBack({ delta: 1 });
    },
    book(event) {
        const therapist = this.data.therapist;
        if (!therapist)
            return;
        wx.navigateTo({
            url: `/pages/booking/index?slug=${encodeURIComponent(event.currentTarget.dataset.slug)}&therapistId=${encodeURIComponent(therapist.id)}`,
        });
    },
});
