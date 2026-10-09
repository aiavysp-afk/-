"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serviceBookingAction = exports.serviceBookingLabel = exports.serviceBookingState = exports.loadPublicServiceDiscovery = void 0;
const api_1 = require("./api");
const therapists_1 = require("./therapists");
const shanghaiDate = (offsetDays) => new Date(Date.now() + 8 * 3600000 + offsetDays * 86400000)
    .toISOString()
    .slice(0, 10);
// A single public snapshot supplies both the technician stream and project
// cards. One failed project's schedule must not hide other real technicians.
const loadPublicServiceDiscovery = async () => {
    const [profiles, services] = await Promise.all([
        (0, api_1.api)("/technicians"),
        (0, api_1.api)("/catalog/services"),
    ]);
    if (profiles.some((profile) => profile.freeTravelFee !== true || profile.travelFeeFen !== 0))
        throw new Error("技师出行费配置异常，已阻止下单");
    if (!profiles.length)
        return {
            services,
            therapists: [],
            profileCount: 0,
            failedServiceIds: [],
        };
    const dates = [shanghaiDate(0), shanghaiDate(1)];
    const results = await Promise.allSettled(services.map(async (service) => {
        const [today, tomorrow] = await Promise.all(dates.map((date) => (0, api_1.api)(`/availability/slots?serviceId=${encodeURIComponent(service.id)}&date=${date}`)));
        return { service, today: today, tomorrow: tomorrow };
    }));
    const rows = [];
    const failedServiceIds = [];
    results.forEach((result, index) => {
        if (result.status === "fulfilled")
            rows.push(result.value);
        else
            failedServiceIds.push(services[index].id);
    });
    const profileOrder = new Map(profiles.map((profile, index) => [profile.technicianId, index]));
    const therapists = (0, therapists_1.buildPublicTherapists)(rows, profiles).sort((left, right) => {
        var _a, _b;
        return ((_a = profileOrder.get(left.id)) !== null && _a !== void 0 ? _a : profiles.length) -
            ((_b = profileOrder.get(right.id)) !== null && _b !== void 0 ? _b : profiles.length);
    });
    return {
        services,
        therapists,
        profileCount: profiles.length,
        failedServiceIds,
    };
};
exports.loadPublicServiceDiscovery = loadPublicServiceDiscovery;
const serviceBookingState = (serviceId, snapshot) => {
    var _a, _b;
    if (snapshot.failedServiceIds.includes(serviceId))
        return { bookingState: "ERROR", therapistId: "", bookableCount: 0 };
    const matches = snapshot.therapists.filter((therapist) => therapist.publishedProfile &&
        therapist.bookable &&
        therapist.services.some((service) => service.id === serviceId && service.slots.length > 0));
    return {
        bookingState: matches.length
            ? "AVAILABLE"
            : snapshot.profileCount
                ? "NO_SLOTS"
                : "NO_PROFILE",
        therapistId: (_b = (_a = matches[0]) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : "",
        bookableCount: matches.length,
    };
};
exports.serviceBookingState = serviceBookingState;
const serviceBookingLabel = (state) => ({
    LOADING: "读取可约状态…",
    AVAILABLE: "可预约",
    NO_PROFILE: "技师上线中",
    NO_SLOTS: "待开放时段",
    ERROR: "排班读取失败",
})[state];
exports.serviceBookingLabel = serviceBookingLabel;
const serviceBookingAction = (state) => ({
    LOADING: "正在更新",
    AVAILABLE: "选技师 ›",
    NO_PROFILE: "待技师上线",
    NO_SLOTS: "时段待开放",
    ERROR: "重试读取 ›",
})[state];
exports.serviceBookingAction = serviceBookingAction;
