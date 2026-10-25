import type { HomeCampaign } from "@zydj/contracts";
export const campaignStorageKey = "zydj.home-campaign.seen";
export const campaignIdentity = (campaign: HomeCampaign) =>
  `${campaign.organizationId}:${campaign.version}`;
export const chinaDay = (time: number) =>
  new Date(time + 8 * 3600000).toISOString().slice(0, 10);
export function shouldShowCampaign(
  campaign: HomeCampaign | null,
  saved: unknown,
  now = Date.now(),
) {
  if (
    !campaign?.enabled ||
    (campaign.startsAt && Date.parse(campaign.startsAt) > now) ||
    (campaign.endsAt && Date.parse(campaign.endsAt) <= now)
  )
    return false;
  if (!saved || typeof saved !== "object") return true;
  const previous = saved as { identity?: unknown; day?: unknown };
  if (previous.identity !== campaignIdentity(campaign)) return true;
  return campaign.frequency === "DAILY" && previous.day !== chinaDay(now);
}
