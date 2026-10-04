"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openWecomCustomerService = openWecomCustomerService;
exports.callEmergencyDuty = callEmergencyDuty;
function openWecomCustomerService(contact, host = wx) {
    // Synchronous tap handler: no network await before invoking the native user-gesture API.
    if (!(contact === null || contact === void 0 ? void 0 : contact.available) ||
        contact.provider !== "wecom" ||
        !/^ww[A-Za-z0-9]{16}$/.test(contact.corpId) ||
        !/^https:\/\/work\.weixin\.qq\.com\/(?:kfid|kf)\/[A-Za-z0-9_-]{5,128}(?:\?enc_scene=[A-Za-z0-9%_=-]{1,256})?$/.test(contact.url)) {
        host.showToast({
            title: "企业微信客服尚未配置，紧急情况请立即求助",
            icon: "none",
        });
        return;
    }
    if (typeof host.openCustomerServiceChat !== "function") {
        host.showToast({ title: "当前微信版本不支持，请升级后重试", icon: "none" });
        return;
    }
    host.openCustomerServiceChat({
        corpId: contact.corpId,
        extInfo: { url: contact.url },
        fail: () => host.showToast({
            title: "客服入口未打开，请重试；紧急情况请立即求助",
            icon: "none",
        }),
    });
}
function callEmergencyDuty(contact, host = wx) {
    if (!(contact === null || contact === void 0 ? void 0 : contact.configured) || !/^1[3-9]\d{9}$/.test(contact.phone)) {
        host.showToast({
            title: "商家紧急值班电话未配置，请立即寻求其他帮助",
            icon: "none",
        });
        return;
    }
    host.makePhoneCall({
        phoneNumber: contact.phone,
        fail: () => host.showToast({
            title: "拨号未完成，请手动拨号或寻求其他帮助",
            icon: "none",
        }),
    });
}
