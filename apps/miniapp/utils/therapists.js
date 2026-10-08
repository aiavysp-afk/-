"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPublicTherapists = exports.buildPublicTherapists = void 0;
const api_1 = require("./api");
const shanghaiDate = (offsetDays) => new Date(Date.now() + 8 * 60 * 60 * 1000 + offsetDays * 86400000)
    .toISOString()
    .slice(0, 10);
const buildPublicTherapists = (rows) => {
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
    return [...records.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, record], index) => {
        const services = [...record.services.values()];
        const earliest = services
            .flatMap((service) => service.slots)
            .sort((left, right) => left.startsAt.localeCompare(right.startsAt))[0];
        const availableToday = record.todaySlotCount > 0;
        return {
            id,
            alias: `认证技师 ${String(index + 1).padStart(2, "0")}`,
            avatarIndex: index % 4,
            badge: availableToday ? "优先可约" : "预约开放",
            bookable: services.length > 0,
            earliestLabel: earliest
                ? `${earliest.dayLabel} ${earliest.timeLabel}`
                : "暂无可约时间",
            orderCountLabel: "履约数据待授权",
            profile: "平台已完成基础资料核验。为保护服务人员隐私，真实姓名、照片及更多职业资料仅在取得本人公开展示授权后提供。",
            ratingLabel: "暂无公开评分",
            services,
            statusLabel: availableToday ? "今日可约" : "明日可约",
            statusTone: availableToday ? "online" : "scheduled",
            storeLabel: "所属门店资料待公开",
            tags: ["平台核验", availableToday ? "今日有排班" : "明日有排班"],
            todaySlotCount: record.todaySlotCount,
            tomorrowSlotCount: record.tomorrowSlotCount,
            travelLabel: "出行费按地址报价",
        };
    });
};
exports.buildPublicTherapists = buildPublicTherapists;
const loadPublicTherapists = async () => {
    const services = await (0, api_1.api)("/catalog/services");
    const today = shanghaiDate(0);
    const tomorrow = shanghaiDate(1);
    const rows = await Promise.all(services.map(async (service) => {
        const [todaySlots, tomorrowSlots] = await Promise.all([
            (0, api_1.api)(`/availability/slots?serviceId=${encodeURIComponent(service.id)}&date=${today}`),
            (0, api_1.api)(`/availability/slots?serviceId=${encodeURIComponent(service.id)}&date=${tomorrow}`),
        ]);
        return { service, today: todaySlots, tomorrow: tomorrowSlots };
    }));
    return (0, exports.buildPublicTherapists)(rows);
};
exports.loadPublicTherapists = loadPublicTherapists;
