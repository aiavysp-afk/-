import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type Service } from "@prisma/client";
import type {
  AdminServiceItem,
  ServiceAdminUpdate,
  ServiceItem,
  TechnicianReview,
} from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  async listPublished(): Promise<ServiceItem[]> {
    const services = await this.prisma.service.findMany({
      where: { published: true },
      orderBy: [{ featured: "desc" }, { priceFen: "asc" }, { name: "asc" }],
    });
    return services.map((service) => this.toPublic(service));
  }

  async getPublished(slug: string): Promise<ServiceItem> {
    const service = await this.prisma.service.findFirst({
      where: { slug, published: true },
    });
    if (!service) throw new NotFoundException("服务不存在或未上架");
    return this.toPublic(service);
  }

  async listPublishedReviews(slug: string): Promise<TechnicianReview[]> {
    const service = await this.prisma.service.findFirst({
      where: { slug, published: true },
      select: { id: true },
    });
    if (!service) throw new NotFoundException("服务不存在或未上架");
    const reviews = await this.prisma.technicianReview.findMany({
      where: {
        status: "PUBLISHED",
        order: { items: { some: { serviceId: service.id } } },
      },
      include: { customer: { select: { displayName: true } } },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    return reviews.map((review) => ({
      id: review.id,
      technicianId: review.technicianId,
      customerAlias: this.customerAlias(review.customer.displayName),
      rating: review.rating,
      content: review.content,
      createdAt: review.createdAt.toISOString(),
    }));
  }

  async listForAdmin(
    principal: AuthPrincipal,
    requestedOrganizationId?: string,
  ) {
    const allowedOrganizationIds = this.access.allowedOrganizationIds(
      principal,
      "catalog.write",
    );
    if (!allowedOrganizationIds.length)
      throw new ForbiddenException("当前身份无权管理服务目录");
    if (
      requestedOrganizationId &&
      !allowedOrganizationIds.includes(requestedOrganizationId)
    ) {
      throw new ForbiddenException("不能管理其他组织的服务目录");
    }
    const organizationIds = requestedOrganizationId
      ? [requestedOrganizationId]
      : allowedOrganizationIds;
    const services = await this.prisma.service.findMany({
      where: { organizationId: { in: organizationIds } },
      orderBy: [{ updatedAt: "desc" }],
    });
    return services.map((service) => this.toAdmin(service));
  }

  async update(
    principal: AuthPrincipal,
    id: string,
    input: ServiceAdminUpdate,
  ) {
    const service = await this.getAuthorizedService(principal, id);
    const data: Prisma.ServiceUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.category !== undefined) data.category = input.category;
    if (input.subtitle !== undefined) data.subtitle = input.subtitle;
    if (input.badge !== undefined) data.badge = input.badge;
    if (input.description !== undefined) data.description = input.description;
    if (input.durationMinutes !== undefined)
      data.durationMinutes = input.durationMinutes;
    if (input.priceFen !== undefined) data.priceFen = BigInt(input.priceFen);
    if (input.featured !== undefined) data.featured = input.featured;
    if (input.steps !== undefined) data.steps = input.steps;
    if (input.boundaries !== undefined) data.boundaries = input.boundaries;

    const updated = await this.prisma.$transaction(async (tx) => {
      const record = await tx.service.update({ where: { id }, data });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: service.organizationId,
          action: "CATALOG_SERVICE_UPDATED",
          resourceType: "Service",
          resourceId: id,
          metadata: { changedFields: Object.keys(input).sort() },
        },
      });
      return record;
    });
    return this.toAdmin(updated);
  }

  async setPublished(principal: AuthPrincipal, id: string, published: boolean) {
    const service = await this.getAuthorizedService(principal, id);
    if (published) this.assertPublishable(service);
    if (service.published === published) return this.toAdmin(service);

    const updated = await this.prisma.$transaction(async (tx) => {
      const record = await tx.service.update({
        where: { id },
        data: { published },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: service.organizationId,
          action: published
            ? "CATALOG_SERVICE_PUBLISHED"
            : "CATALOG_SERVICE_UNPUBLISHED",
          resourceType: "Service",
          resourceId: id,
          metadata: {},
        },
      });
      return record;
    });
    return this.toAdmin(updated);
  }

  private async getAuthorizedService(principal: AuthPrincipal, id: string) {
    const service = await this.prisma.service.findUnique({ where: { id } });
    if (!service) throw new NotFoundException("服务不存在");
    this.access.assertPermission(
      principal,
      "catalog.write",
      service.organizationId,
    );
    return service;
  }

  private assertPublishable(service: Service) {
    const steps = this.stringArray(service.steps);
    const boundaries = this.stringArray(service.boundaries);
    if (
      !service.name.trim() ||
      !service.description.trim() ||
      service.durationMinutes <= 0 ||
      service.priceFen < 0n ||
      !steps.length ||
      !boundaries.length
    ) {
      throw new ForbiddenException("服务资料不完整，不能上架");
    }
  }

  private toPublic(service: Service): ServiceItem {
    const priceFen = Number(service.priceFen);
    if (!Number.isSafeInteger(priceFen)) {
      throw new InternalServerErrorException("服务价格超出安全序列化范围");
    }
    return {
      id: service.id,
      slug: service.slug,
      name: service.name,
      category: service.category,
      subtitle: service.subtitle,
      description: service.description,
      durationMinutes: service.durationMinutes,
      priceFen,
      badge: service.badge ?? undefined,
      featured: service.featured,
      steps: this.stringArray(service.steps),
      boundaries: this.stringArray(service.boundaries),
    };
  }

  private toAdmin(service: Service): AdminServiceItem {
    return {
      ...this.toPublic(service),
      organizationId: service.organizationId,
      published: service.published,
      updatedAt: service.updatedAt.toISOString(),
    };
  }

  private stringArray(value: Prisma.JsonValue) {
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string")
    ) {
      throw new InternalServerErrorException("服务资料格式异常");
    }
    return value;
  }

  private customerAlias(displayName: string) {
    const name = displayName.trim();
    return name ? `${Array.from(name)[0]}**` : "匿名用户";
  }
}
