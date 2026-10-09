import { Prisma, type Service } from "@prisma/client";
import { ServiceItemSchema, type ServiceItem } from "@zydj/contracts";

export const RECOMMENDED_CATALOG_ORGANIZATION_ID = "org-zhongyuan-production";

const boundaries = [
  "正规非医疗保健放松，不提供诊断、治疗或疗效承诺",
  "不涉及私密部位，禁止违法或超出公示范围的要求",
  "身体不适、皮肤破损或其他禁忌情形须先告知并暂停服务",
];

/** Reviewed product definitions only; technician skills and credentials are not seeded. */
export const recommendedCatalog: ServiceItem[] = [
  {
    id: "svc-french-spa-120",
    slug: "french-spa-120",
    name: "法式SPA",
    category: "SPA_RELAXATION",
    subtitle: "舒缓节奏，享受自在放松时光",
    description:
      "120分钟非医疗SPA放松服务。服务前沟通个人需求与禁忌，使用规范铺巾及清洁耗材，按约定部位进行舒缓护理；具体步骤以双方确认的项目说明为准。",
    durationMinutes: 120,
    priceFen: 49_800,
    badge: "舒缓放松",
    featured: true,
    steps: [
      "需求与禁忌沟通",
      "用品消毒与规范铺巾",
      "分区舒缓护理",
      "放松收尾与用品回收",
    ],
    boundaries,
  },
  {
    id: "svc-thai-spa-120",
    slug: "thai-spa-120",
    name: "泰式SPA",
    category: "SPA_RELAXATION",
    subtitle: "温和伸展，卸下日常疲惫",
    description:
      "120分钟泰式非医疗放松服务。经沟通确认可接受的力度与活动范围后，进行温和分区放松与辅助伸展；不进行强制扳动或治疗性操作。",
    durationMinutes: 120,
    priceFen: 39_800,
    badge: "温和伸展",
    featured: true,
    steps: [
      "需求与活动范围沟通",
      "用品清洁与铺巾",
      "分区放松与温和伸展",
      "结束反馈与用品回收",
    ],
    boundaries,
  },
  {
    id: "svc-tongluo-peiyuan-80",
    slug: "tongluo-peiyuan-80",
    name: "通络培元",
    category: "MASSAGE",
    subtitle: "日常保健，舒缓紧绷与疲劳",
    description:
      "80分钟日常非医疗保健放松服务。按双方确认的部位和力度进行规范舒缓操作；项目名称不代表医疗诊断、疏通经络效果或治疗承诺。",
    durationMinutes: 80,
    priceFen: 29_800,
    badge: "日常保健",
    featured: true,
    steps: [
      "需求与禁忌确认",
      "用品消毒与准备",
      "规范分区舒缓",
      "休息提示与结束反馈",
    ],
    boundaries,
  },
  {
    id: "svc-chinese-tuina-60",
    slug: "chinese-tuina-60",
    name: "中式推拿",
    category: "MASSAGE",
    subtitle: "轻松入门，感受规范中式放松",
    description:
      "60分钟中式非医疗推拿放松服务。服务前确认身体状态和力度偏好，按约定区域进行日常疲劳舒缓，不替代医疗检查或专业治疗。",
    durationMinutes: 60,
    priceFen: 21_800,
    badge: "轻松入门",
    featured: true,
    steps: [
      "身体状态与力度沟通",
      "用品清洁与准备",
      "约定区域舒缓放松",
      "结束反馈与用品回收",
    ],
    boundaries,
  },
  {
    id: "svc-ear-care-70",
    slug: "ear-care-70",
    name: "非遗采耳",
    category: "MASSAGE",
    subtitle: "清洁用品，轻柔耳周放松体验",
    description:
      "70分钟非医疗耳周放松与日常清洁体验。需由具备相应技能并经审核的技师提供；耳部疼痛、炎症、出血或其他不适时不服务。项目名不作为非遗认证或人员资质证明。",
    durationMinutes: 70,
    priceFen: 23_800,
    badge: "轻柔体验",
    featured: true,
    steps: [
      "耳部状态与禁忌沟通",
      "专业用品清洁与准备",
      "约定范围轻柔护理",
      "用品回收与结束反馈",
    ],
    boundaries: [
      ...boundaries,
      "耳部疼痛、炎症、出血或近期手术等情形不提供服务",
    ],
  },
].map((item) => ServiceItemSchema.parse(item));

const contentFor = (item: ServiceItem) => ({
  name: item.name,
  category: item.category,
  subtitle: item.subtitle,
  badge: item.badge ?? null,
  description: item.description,
  durationMinutes: item.durationMinutes,
  priceFen: BigInt(item.priceFen),
  featured: item.featured,
  published: true,
  steps: item.steps,
  boundaries: item.boundaries,
});

type CatalogContent = ReturnType<typeof contentFor>;
export type RecommendedCatalogChange = {
  action: "CREATE" | "UPDATE" | "UNCHANGED";
  id: string;
  slug: string;
  content: CatalogContent;
  changedFields: string[];
  previous: Service | null;
};

/** Retains matching IDs/slugs and refuses ambiguous/cross-organization ownership. */
export function planRecommendedCatalog(
  existing: Service[],
  organizationId = RECOMMENDED_CATALOG_ORGANIZATION_ID,
): RecommendedCatalogChange[] {
  return recommendedCatalog.map((item) => {
    const keyMatches = existing.filter(
      (service) => service.slug === item.slug || service.id === item.id,
    );
    if (
      keyMatches.some((service) => service.organizationId !== organizationId)
    ) {
      throw new Error(
        "Recommended service ID or slug belongs to another organization",
      );
    }
    const candidates = existing.filter(
      (service) =>
        service.organizationId === organizationId &&
        (service.slug === item.slug ||
          service.id === item.id ||
          service.name === item.name),
    );
    if (candidates.length > 1) {
      throw new Error(`Ambiguous existing recommended service: ${item.name}`);
    }
    const previous = candidates[0] ?? null;
    if (
      previous?.id === item.id &&
      previous.slug !== item.slug &&
      previous.name !== item.name
    ) {
      throw new Error(
        "Recommended service ID is already used by an unrelated service",
      );
    }
    const content = contentFor(item);
    const changedFields = previous
      ? Object.entries(content)
          .filter(([field, value]) => {
            const current = previous[field as keyof Service];
            return typeof value === "bigint"
              ? current !== value
              : JSON.stringify(current) !== JSON.stringify(value);
          })
          .map(([field]) => field)
          .sort()
      : Object.keys(content).sort();
    return {
      action: !previous
        ? "CREATE"
        : changedFields.length
          ? "UPDATE"
          : "UNCHANGED",
      id: previous?.id ?? item.id,
      slug: previous?.slug ?? item.slug,
      content,
      changedFields,
      previous,
    };
  });
}

export async function applyRecommendedCatalog(
  tx: Prisma.TransactionClient,
  plan: RecommendedCatalogChange[],
  organizationId = RECOMMENDED_CATALOG_ORGANIZATION_ID,
) {
  for (const change of plan) {
    if (change.action === "UNCHANGED") continue;
    if (change.action === "CREATE") {
      await tx.service.create({
        data: {
          id: change.id,
          slug: change.slug,
          organizationId,
          ...change.content,
        },
      });
    } else {
      await tx.service.update({
        where: { id: change.id },
        data: change.content,
      });
    }
    await tx.auditLog.create({
      data: {
        organizationId,
        action: "RECOMMENDED_CATALOG_APPLIED",
        resourceType: "Service",
        resourceId: change.id,
        metadata: {
          version: "20261009",
          operation: change.action,
          changedFields: change.changedFields,
          previousPriceFen: change.previous
            ? Number(change.previous.priceFen)
            : null,
          previousDurationMinutes: change.previous?.durationMinutes ?? null,
          priceFen: Number(change.content.priceFen),
          durationMinutes: change.content.durationMinutes,
          preservedExistingId: change.previous !== null,
        },
      },
    });
    await tx.outboxEvent.create({
      data: {
        organizationId,
        aggregateId: change.id,
        type: "CATALOG_SERVICE_UPDATED",
        payload: { version: "20261009", changedFields: change.changedFields },
      },
    });
  }
}

export function assertRecommendedCatalogTarget(
  env: Record<string, string | undefined>,
) {
  let target: URL;
  try {
    target = new URL(env.DATABASE_URL ?? "");
  } catch {
    throw new Error(
      "Recommended catalog requires a valid local database target",
    );
  }
  if (
    env.NODE_ENV !== "production" ||
    !["postgres:", "postgresql:"].includes(target.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.pathname !== "/zhongyuan_daojia"
  ) {
    throw new Error(
      "Recommended catalog requires the existing local production database",
    );
  }
}
