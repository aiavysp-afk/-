import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  TechnicianProfileUpdateSchema,
  TechnicianReviewCreateSchema,
} from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { TechniciansService } from "./technicians.service.js";

@Controller("technicians")
export class PublicTechniciansController {
  constructor(private readonly technicians: TechniciansService) {}

  @Get()
  async list() {
    const data = await this.technicians.listPublic();
    return { data, meta: { total: data.length } };
  }

  @Get(":technicianId/reviews")
  async reviews(@Param("technicianId") technicianId: string) {
    const data = await this.technicians.listPublicReviews(technicianId);
    return { data, meta: { total: data.length } };
  }

  @Get(":technicianId")
  async get(@Param("technicianId") technicianId: string) {
    return { data: await this.technicians.getPublic(technicianId) };
  }
}

@Controller("technician/workbench/profile")
@UseGuards(SessionAuthGuard)
export class TechnicianProfileController {
  constructor(private readonly technicians: TechniciansService) {}

  @Get()
  async get(@CurrentPrincipal() principal: AuthPrincipal) {
    return { data: await this.technicians.getOwnProfile(principal) };
  }

  @Patch()
  async update(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const parsed = TechnicianProfileUpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("技师资料参数无效");
    return {
      data: await this.technicians.updateOwnProfile(principal, parsed.data),
    };
  }

  @Post("submit-review")
  async submit(@CurrentPrincipal() principal: AuthPrincipal) {
    return { data: await this.technicians.submitOwnProfile(principal) };
  }
}

@Controller(
  "admin/organizations/:organizationId/technicians/:technicianId/profile",
)
@UseGuards(SessionAuthGuard)
export class AdminTechnicianProfileController {
  constructor(private readonly technicians: TechniciansService) {}

  @Get()
  async get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("technicianId") technicianId: string,
  ) {
    return {
      data: await this.technicians.getAdminProfile(
        principal,
        organizationId,
        technicianId,
      ),
    };
  }

  @Patch()
  async update(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("technicianId") technicianId: string,
    @Body() body: unknown,
  ) {
    const parsed = TechnicianProfileUpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("技师资料参数无效");
    return {
      data: await this.technicians.updateAdminProfile(
        principal,
        organizationId,
        technicianId,
        parsed.data,
      ),
    };
  }

  @Post("approve")
  async approve(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("technicianId") technicianId: string,
  ) {
    return {
      data: await this.technicians.approve(
        principal,
        organizationId,
        technicianId,
      ),
    };
  }

  @Post("publish")
  async publish(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("technicianId") technicianId: string,
  ) {
    return {
      data: await this.technicians.publish(
        principal,
        organizationId,
        technicianId,
      ),
    };
  }

  @Post("unpublish")
  async unpublish(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("technicianId") technicianId: string,
  ) {
    return {
      data: await this.technicians.unpublish(
        principal,
        organizationId,
        technicianId,
      ),
    };
  }
}

@Controller(
  "admin/organizations/:organizationId/technicians/:technicianId/reviews",
)
@UseGuards(SessionAuthGuard)
export class AdminTechnicianReviewsController {
  constructor(private readonly technicians: TechniciansService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("technicianId") technicianId: string,
  ) {
    const data = await this.technicians.listAdminReviews(
      principal,
      organizationId,
      technicianId,
    );
    return { data, meta: { total: data.length } };
  }

  @Post(":reviewId/publish")
  async publish(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("technicianId") technicianId: string,
    @Param("reviewId") reviewId: string,
  ) {
    return {
      data: await this.technicians.publishReview(
        principal,
        organizationId,
        technicianId,
        reviewId,
      ),
    };
  }

  @Post(":reviewId/hide")
  async hide(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("technicianId") technicianId: string,
    @Param("reviewId") reviewId: string,
  ) {
    return {
      data: await this.technicians.hideReview(
        principal,
        organizationId,
        technicianId,
        reviewId,
      ),
    };
  }
}

@Controller("orders/:orderId/reviews")
@UseGuards(SessionAuthGuard)
export class TechnicianReviewsController {
  constructor(private readonly technicians: TechniciansService) {}

  @Post()
  async create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("orderId") orderId: string,
    @Body() body: unknown,
  ) {
    const parsed = TechnicianReviewCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("评价参数无效");
    return {
      data: await this.technicians.createReview(
        principal,
        orderId,
        parsed.data,
      ),
    };
  }
}
