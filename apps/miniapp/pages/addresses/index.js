"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const amap_1 = require("../../utils/amap");
const auth_1 = require("../../utils/auth");
const customer_center_1 = require("../../utils/customer-center");
const blankDraft = () => ({
    id: "",
    contactName: "",
    phone: "",
    detail: "",
    latitude: null,
    longitude: null,
    isDefault: false,
});
Page({
    data: {
        addresses: [],
        loading: false,
        error: "",
        formOpen: false,
        formTitle: "新增地址",
        draft: blankDraft(),
        busy: false,
        locating: false,
        amapMiniappKey: "",
        serviceCity: "郑州市",
    },
    back() {
        wx.navigateBack({ delta: 1 });
    },
    async onShow() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        await Promise.all([this.load(), this.loadMapConfig()]);
    },
    async load() {
        this.setData({ loading: true, error: "" });
        try {
            const addresses = await (0, api_1.api)((0, customer_center_1.customerCenterPath)("/customer-center/addresses"));
            this.setData({ addresses });
        }
        catch (error) {
            this.setData({
                addresses: [],
                error: error instanceof Error ? error.message : "地址读取失败",
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    async loadMapConfig() {
        try {
            const config = await (0, api_1.api)("/config/public");
            this.setData({
                amapMiniappKey: config.map.miniappKey,
                serviceCity: config.serviceCity,
            });
        }
        catch {
            // Manual address geocoding is performed by the backend as a fallback.
        }
    },
    openNew() {
        this.setData({
            formOpen: true,
            formTitle: "新增服务地址",
            draft: blankDraft(),
            error: "",
        });
    },
    openEdit(event) {
        const address = this.data.addresses.find((item) => item.id === event.currentTarget.dataset.id);
        if (!address)
            return;
        this.setData({
            formOpen: true,
            formTitle: "编辑服务地址",
            draft: {
                id: address.id,
                contactName: address.contactName,
                phone: address.phone,
                detail: address.detail,
                latitude: address.latitude,
                longitude: address.longitude,
                isDefault: address.isDefault,
            },
            error: "",
        });
    },
    closeForm() {
        if (this.data.busy || this.data.locating)
            return;
        this.setData({ formOpen: false, draft: blankDraft(), error: "" });
    },
    keepFormOpen() { },
    inputChanged(event) {
        const field = event.currentTarget.dataset.field;
        const draft = {
            ...this.data.draft,
            [field]: event.detail.value,
            ...(field === "detail" ? { latitude: null, longitude: null } : {}),
        };
        this.setData({ draft, error: "" });
    },
    defaultChanged(event) {
        this.setData({
            draft: { ...this.data.draft, isDefault: event.detail.value },
        });
    },
    async locateCurrent() {
        if (this.data.locating)
            return;
        this.setData({ locating: true, error: "" });
        try {
            const point = await (0, amap_1.getGcj02Location)();
            const address = await (0, amap_1.reverseGeocode)(this.data.amapMiniappKey, point);
            this.setData({
                draft: {
                    ...this.data.draft,
                    detail: address.detail.slice(0, 200),
                    latitude: point.latitude,
                    longitude: point.longitude,
                },
            });
            wx.showToast({ title: "已识别当前地址", icon: "success" });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error
                    ? error.message
                    : "定位失败，请允许定位或手动填写郑州地址",
            });
        }
        finally {
            this.setData({ locating: false });
        }
    },
    async ensureCoordinates() {
        if (this.data.draft.latitude !== null && this.data.draft.longitude !== null)
            return {
                latitude: this.data.draft.latitude,
                longitude: this.data.draft.longitude,
            };
        const geocoded = await (0, api_1.api)("/locations/address-geocodes", "POST", { detail: this.data.draft.detail.trim() });
        this.setData({
            draft: {
                ...this.data.draft,
                latitude: geocoded.latitude,
                longitude: geocoded.longitude,
            },
        });
        wx.showToast({ title: "手填地址已用高德识别", icon: "success" });
        return geocoded;
    },
    async save() {
        if (this.data.busy)
            return;
        const draft = this.data.draft;
        if (draft.contactName.trim().length < 2) {
            this.setData({ error: "联系人至少填写 2 个字" });
            return;
        }
        if (!/^1\d{10}$/.test(draft.phone.trim())) {
            this.setData({ error: "请填写有效的 11 位联系电话" });
            return;
        }
        if (draft.detail.trim().length < 5) {
            this.setData({ error: "请填写完整的郑州地址和门牌号" });
            return;
        }
        this.setData({ busy: true, error: "" });
        try {
            const point = await this.ensureCoordinates();
            if (draft.id) {
                const payload = {
                    contactName: draft.contactName.trim(),
                    phone: draft.phone.trim(),
                    detail: draft.detail.trim(),
                    latitude: point.latitude,
                    longitude: point.longitude,
                    coordinateSystem: "GCJ-02",
                    isDefault: draft.isDefault,
                };
                await (0, api_1.api)(`/customer-center/addresses/${encodeURIComponent(draft.id)}`, "PATCH", payload);
            }
            else {
                const organizationId = (0, customer_center_1.getCustomerCenterOrganizationId)();
                const payload = {
                    ...(organizationId ? { organizationId } : {}),
                    contactName: draft.contactName.trim(),
                    phone: draft.phone.trim(),
                    detail: draft.detail.trim(),
                    latitude: point.latitude,
                    longitude: point.longitude,
                    coordinateSystem: "GCJ-02",
                    isDefault: draft.isDefault,
                };
                await (0, api_1.api)("/customer-center/addresses", "POST", payload, (0, api_1.newKey)());
            }
            this.setData({ formOpen: false, draft: blankDraft() });
            wx.showToast({ title: "地址已保存", icon: "success" });
            await this.load();
        }
        catch (error) {
            this.setData({
                error: error instanceof Error
                    ? `${error.message}。请完善郑州地址或使用高德定位后重试`
                    : "地址保存失败，请完善郑州地址后重试",
            });
        }
        finally {
            this.setData({ busy: false });
        }
    },
    async setDefault(event) {
        const id = event.currentTarget.dataset.id;
        try {
            await (0, api_1.api)(`/customer-center/addresses/${encodeURIComponent(id)}`, "PATCH", { isDefault: true });
            wx.showToast({ title: "已设为默认地址", icon: "success" });
            await this.load();
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "默认地址设置失败",
            });
        }
    },
    async remove(event) {
        const id = event.currentTarget.dataset.id;
        const confirmed = await new Promise((resolve) => wx.showModal({
            title: "删除这个地址？",
            content: "只删除地址簿记录，不影响历史订单中依法留存的服务地址。",
            confirmText: "确认删除",
            success: (result) => resolve(result.confirm === true),
            fail: () => resolve(false),
        }));
        if (!confirmed)
            return;
        try {
            await (0, api_1.api)(`/customer-center/addresses/${encodeURIComponent(id)}`, "DELETE");
            wx.showToast({ title: "地址已删除", icon: "success" });
            await this.load();
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "地址删除失败",
            });
        }
    },
});
