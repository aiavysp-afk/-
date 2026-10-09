"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPublicTherapist = exports.loadPublicTherapists = exports.buildPublicTherapists = void 0;
const api_1 = require("./api");
const shanghaiDate = (offsetDays) => new Date(Date.now() + 8 * 60 * 60 * 1000 + offsetDays * 86400000)
    .toISOString()
    .slice(0, 10);
const statusLabel = (todaySlotCount, tomorrowSlotCount) => {
    if (todaySlotCount > 0)
        return "今日可约";
    if (tomorrowSlotCount > 0)
        return "明日可约";
    return "暂不可约";
};
const formatRating = (profile) => {
    if (!profile ||
        profile.reviewSummary.averageRating === null ||
        profile.reviewSummary.reviewCount === 0)
        return "暂无评价";
    return `${profile.reviewSummary.averageRating.toFixed(1)}分 · ${profile.reviewSummary.reviewCount}条`;
};
const buildPublicTherapists = (rows, profiles = []) => {
    var _a;
    const records = new Map();
    for (const row of rows) {
        const slots = [
            ...row.today.map((slot) => ({
                ...slot,
                day: "TODAY",
                dayLabel: "今天",
                timeLabel: (0, api_1.shanghaiTime)(slot.startsAt),
            })),
            ...row.tomorrow.map((slot) => ({
                ...slot,
                day: "TOMORROW",
                dayLabel: "明天",
                timeLabel: (0, api_1.shanghaiTime)(slot.startsAt),
            })),
        ];
        const therapistIds = [...new Set(slots.map((slot) => slot.therapistId))];
        for (const therapistId of therapistIds) {
            const record = (_a = records.get(therapistId)) !== null && _a !== void 0 ? _a : {
                services: new Map(),
                todaySlotCount: 0,
                tomorrowSlotCount: 0,
            };
            const therapistSlots = slots
                .filter((slot) => slot.therapistId === therapistId)
                .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
            record.todaySlotCount += therapistSlots.filter((slot) => slot.day === "TODAY").length;
            record.tomorrowSlotCount += therapistSlots.filter((slot) => slot.day === "TOMORROW").length;
            record.services.set(row.service.id, {
                ...row.service,
                price: (0, api_1.money)(row.service.priceFen),
                slots: therapistSlots,
            });
            records.set(therapistId, record);
        }
    }
    // Published profiles without a future shift remain visible, but cannot be
    // booked until the shared scheduling backend returns a real slot.
    for (const profile of profiles) {
        if (!records.has(profile.technicianId)) {
            records.set(profile.technicianId, {
                services: new Map(),
                todaySlotCount: 0,
                tomorrowSlotCount: 0,
            });
        }
    }
    const profileById = new Map(profiles.map((profile) => [profile.technicianId, profile]));
    return [...records.entries()]
        .filter(([id]) => profileById.has(id))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, record], index) => {
        var _a;
        const profile = profileById.get(id);
        if (!profile)
            throw new Error("技师公开资料缺失");
        const services = [...record.services.values()];
        const earliest = services
            .flatMap((service) => service.slots)
            .sort((left, right) => left.startsAt.localeCompare(right.startsAt))[0];
        const bookable = services.some((service) => service.slots.length > 0);
        return {
            id,
            alias: profile.publicName,
            avatarIndex: index % 4,
            avatarUrl: (_a = profile.avatarUrl) !== null && _a !== void 0 ? _a : "",
            badge: bookable ? "优先可约" : "资料已公开",
            bookable,
            completedOrdersLabel: `${profile.reviewSummary.completedOrders}单`,
            earliestLabel: earliest
                ? `${earliest.dayLabel} ${earliest.timeLabel}`
                : "暂无可约时间",
            galleryUrls: profile.galleryUrls,
            orderCountLabel: `${profile.reviewSummary.completedOrders}单已完成`,
            profile: profile.introduction ||
                "该技师尚未发布公开介绍，平台不会代为填写虚构资料。",
            publishedProfile: true,
            qualifications: profile.certificates,
            ratingLabel: formatRating(profile),
            reviewCount: profile.reviewSummary.reviewCount,
            services,
            statusLabel: statusLabel(record.todaySlotCount, record.tomorrowSlotCount),
            statusTone: record.todaySlotCount > 0 ? "online" : "scheduled",
            tags: profile.specialties.length
                ? profile.specialties
                : ["平台核验", bookable ? "已排班" : "待排班"],
            todaySlotCount: record.todaySlotCount,
            tomorrowSlotCount: record.tomorrowSlotCount,
            travelLabel: "免出行费",
            yearsExperienceLabel: profile.serviceYears === null
                ? "待公开"
                : `${profile.serviceYears}年`,
        };
    });
};
exports.buildPublicTherapists = buildPublicTherapists;
const loadPublicTherapists = async () => {
    const [profiles, services] = await Promise.all([
        (0, api_1.api)("/technicians"),
        (0, api_1.api)("/catalog/services"),
    ]);
    if (profiles.some((profile) => profile.freeTravelFee !== true || profile.travelFeeFen !== 0))
        throw new Error("技师出行费配置异常，已阻止下单");
    if (!profiles.length)
        return [];
    const today = shanghaiDate(0);
    const tomorrow = shanghaiDate(1);
    const results = await Promise.allSettled(services.map(async (service) => {
        const [todaySlots, tomorrowSlots] = await Promise.all([
            (0, api_1.api)(`/availability/slots?serviceId=${encodeURIComponent(service.id)}&date=${today}`),
            (0, api_1.api)(`/availability/slots?serviceId=${encodeURIComponent(service.id)}&date=${tomorrow}`),
        ]);
        return { service, today: todaySlots, tomorrow: tomorrowSlots };
    }));
    const rows = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const incomplete = results.some((result) => result.status === "rejected");
    if (services.length && !rows.length)
        throw new Error("项目排班读取失败，请重新加载");
    return (0, exports.buildPublicTherapists)(rows, profiles).map((therapist) => !therapist.bookable && incomplete
        ? {
            ...therapist,
            statusLabel: "排班待确认",
            earliestLabel: "排班读取不完整",
        }
        : therapist);
};
exports.loadPublicTherapists = loadPublicTherapists;
const loadPublicTherapist = async (technicianId) => {
    const [therapists, profile, reviews] = await Promise.all([
        (0, exports.loadPublicTherapists)(),
        (0, api_1.api)(`/technicians/${encodeURIComponent(technicianId)}`),
        (0, api_1.api)(`/technicians/${encodeURIComponent(technicianId)}/reviews`),
    ]);
    const therapist = therapists.find((item) => item.id === technicianId);
    if (!therapist || profile.technicianId !== technicianId)
        throw new Error("该技师资料尚未公开");
    return {
        ...therapist,
        reviews: reviews.map((review) => ({
            ...review,
            content: review.content.trim(),
            dateLabel: (0, api_1.shanghaiTime)(review.createdAt).slice(0, 10),
            ratingLabel: `${review.rating}星`,
            stars: "★".repeat(review.rating),
        })),
    };
};
exports.loadPublicTherapist = loadPublicTherapist;
