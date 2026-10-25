"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chinaDay = exports.campaignIdentity = exports.campaignStorageKey = void 0;
exports.shouldShowCampaign = shouldShowCampaign;
exports.campaignStorageKey = "zydj.home-campaign.seen";
const campaignIdentity = (campaign) => `${campaign.organizationId}:${campaign.version}`;
exports.campaignIdentity = campaignIdentity;
const chinaDay = (time) => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
exports.chinaDay = chinaDay;
function shouldShowCampaign(campaign, saved, now = Date.now()) {
    if (!(campaign === null || campaign === void 0 ? void 0 : campaign.enabled) ||
        (campaign.startsAt && Date.parse(campaign.startsAt) > now) ||
        (campaign.endsAt && Date.parse(campaign.endsAt) <= now))
        return false;
    if (!saved || typeof saved !== "object")
        return true;
    const previous = saved;
    if (previous.identity !== (0, exports.campaignIdentity)(campaign))
        return true;
    return campaign.frequency === "DAILY" && previous.day !== (0, exports.chinaDay)(now);
}
