import {
  ForbiddenException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type Service } from "@prisma/client";
import type {
  AdminServiceItem,
  ServiceAdminCreate,
  ServiceAdminDelete,
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

    const updated = await this.withAuthorizedService(
      principal,
      id,
      async (tx, service) => {
        this.assertSnapshot(service, input.expectedUpdatedAt);
        data.updatedAt = this.nextUpdatedAt(service);
        const record = await tx.service.update({ where: { id }, data });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            organizationId: service.organizationId,
            action: "CATALOG_SERVICE_UPDATED",
            resourceType: "Service",
            resourceId: id,
            metadata: {
              changedFields: Object.keys(input)
                .filter((key) => key !== "expectedUpdatedAt")
                .sort(),
            },
          },
        });
        return record;
      },
    );
    return this.toAdmin(updated);
  }

  async setPublished(principal: AuthPrincipal, id: string, published: boolean) {
    const updated = await this.withAuthorizedService(
      principal,
      id,
      async (tx, service) => {
        if (published) this.assertPublishable(service);
        if (service.published === published) return service;
        const record = await tx.service.update({
          where: { id },
          data: { published, updatedAt: this.nextUpdatedAt(service) },
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
      },
    );
    return this.toAdmin(updated);
  }

  async create(principal: AuthPrincipal, input: ServiceAdminCreate) {
    this.access.assertPermission(
      principal,
      "catalog.write",
      input.organizationId,
    );
    // The browser keeps this UUID across an ambiguous network result. The unique
    // slug makes an explicit retry idempotent without changing the database schema.
    const slug = `service-${input.clientRequestId}`;
    const replay = (service: Service) => {
      if (
        service.organizationId !== input.organizationId ||
        service.name !== input.name ||
        service.category !== input.category ||
        service.subtitle !== input.subtitle ||
        service.badge !== (input.badge ?? null) ||
        service.description !== input.description ||
        service.durationMinutes !== input.durationMinutes ||
        service.priceFen !== BigInt(input.priceFen) ||
        service.featured !== input.featured ||
        JSON.stringify(service.steps) !== JSON.stringify(input.steps) ||
        JSON.stringify(service.boundaries) !== JSON.stringify(input.boundaries)
      )
        throw new ConflictException(
          "本次新增编号已使用，请刷新列表确认项目，不要重复新增",
        );
      return this.toAdmin(service);
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.service.findUnique({ where: { slug } });
        if (existing) return replay(existing);
        const consumed = await tx.auditLog.findFirst({
          where: {
            organizationId: input.organizationId,
            action: "CATALOG_SERVICE_CREATED",
            metadata: {
              path: ["clientRequestId"],
              equals: input.clientRequestId,
            },
          },
          select: { id: true },
        });
        if (consumed)
          throw new ConflictException(
            "本次新增已完成且项目已删除，请刷新列表；如需新项目请重新填写",
          );
        const service = await tx.service.create({
          data: {
            organizationId: input.organizationId,
            slug,
            name: input.name,
            category: input.category,
            subtitle: input.subtitle,
            badge: input.badge ?? null,
            description: input.description,
            durationMinutes: input.durationMinutes,
            priceFen: BigInt(input.priceFen),
            featured: input.featured,
            published: false,
            steps: input.steps,
            boundaries: input.boundaries,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            organizationId: input.organizationId,
            action: "CATALOG_SERVICE_CREATED",
            resourceType: "Service",
            resourceId: service.id,
            metadata: {
              clientRequestId: input.clientRequestId,
              published: false,
            },
          },
        });
        return this.toAdmin(service);
      });
    } catch (caught) {
      if (
        caught instanceof Prisma.PrismaClientKnownRequestError &&
        caught.code === "P2002"
      ) {
        const existing = await this.prisma.service.findUnique({
          where: { slug },
        });
        if (existing) return replay(existing);
        throw new ConflictException("新增项目冲突，请刷新列表后重试");
      }
      throw caught;
    }
  }

  async remove(
    principal: AuthPrincipal,
    id: string,
    input: ServiceAdminDelete,
  ) {
    try {
      return await this.withAuthorizedService(
        principal,
        id,
        async (tx, service) => {
          this.assertSnapshot(service, input.expectedUpdatedAt);
          if (service.published)
            throw new ConflictException(
              "已上架项目不能删除，请先下架；历史订单将继续保留",
            );
          const [orderItems, reservations, technicians] = await Promise.all([
            tx.orderItem.count({ where: { serviceId: id } }),
            tx.appointmentReservation.count({ where: { serviceId: id } }),
            tx.technicianProfile.count({
              where: { serviceIds: { array_contains: [id] } },
            }),
          ]);
          if (orderItems || reservations || technicians)
            throw new ConflictException(
              "项目已关联订单、预约或技师资料，不能删除；保持下架即可停止新预约，历史记录仍保留",
            );
          await tx.service.delete({ where: { id } });
          await tx.auditLog.create({
            data: {
              actorId: principal.userId,
              organizationId: service.organizationId,
              action: "CATALOG_SERVICE_DELETED",
              resourceType: "Service",
              resourceId: id,
              metadata: { name: service.name, slug: service.slug },
            },
          });
          return { id, deleted: true as const };
        },
      );
    } catch (caught) {
      // FK checks also close a race with booking creation outside this transaction.
      if (
        caught instanceof Prisma.PrismaClientKnownRequestError &&
        caught.code === "P2003"
      )
        throw new ConflictException(
          "项目已有预约或订单，不能删除；请保持下架并保留历史记录",
        );
      throw caught;
    }
  }

  private assertSnapshot(service: Service, expectedUpdatedAt?: string) {
    if (
      expectedUpdatedAt &&
      service.updatedAt.getTime() !== Date.parse(expectedUpdatedAt)
    )
      throw new ConflictException("项目资料已变更，请刷新列表后重试");
  }

  private nextUpdatedAt(service: Service) {
    return new Date(Math.max(Date.now(), service.updatedAt.getTime() + 1));
  }

  private async withAuthorizedService<T>(
    principal: AuthPrincipal,
    id: string,
    action: (tx: Prisma.TransactionClient, service: Service) => Promise<T>,
  ) {
    // Check organization permission before acquiring locks, then reread under the
    // lock so a concurrent edit/publish/delete cannot bypass the mutation check.
    await this.getAuthorizedService(principal, id);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Service" WHERE "id" = ${id} FOR UPDATE`;
      const service = await this.getAuthorizedService(principal, id, tx);
      return action(tx, service);
    });
  }

  private async getAuthorizedService(
    principal: AuthPrincipal,
    id: string,
    db: Pick<Prisma.TransactionClient, "service"> = this.prisma,
  ) {
    const service = await db.service.findUnique({ where: { id } });
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
