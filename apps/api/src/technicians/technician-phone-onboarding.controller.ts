import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  TechnicianH5PhotoUploadSchema,
  TechnicianPhoneProfileDraftSchema,
  TechnicianIdentityDocumentUploadSchema,
} from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { TechniciansService } from "./technicians.service.js";

@Controller("technician/phone-onboarding")
@UseGuards(SessionAuthGuard)
export class TechnicianPhoneOnboardingController {
  constructor(private readonly technicians: TechniciansService) {}
  @Get("status")
  @Header("Cache-Control", "private, no-store")
  async status(@CurrentPrincipal() principal: AuthPrincipal) {
    return { data: await this.technicians.phoneOnboardingStatus(principal) };
  }
  @Post("register")
  @Header("Cache-Control", "private, no-store")
  async register(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    this.empty(body);
    return { data: await this.technicians.registerPhone(principal) };
  }
  @Patch("profile")
  @Header("Cache-Control", "private, no-store")
  async profile(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const parsed = TechnicianPhoneProfileDraftSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("资料格式无效，请检查填写内容");
    return {
      data: await this.technicians.updatePhoneApplication(
        principal,
        parsed.data,
      ),
    };
  }
  @Post("photos")
  @Header("Cache-Control", "private, no-store")
  async photo(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const parsed = TechnicianH5PhotoUploadSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        "请选择本人授权的JPG或PNG形象照，单张不超过512KB",
      );
    return {
      data: await this.technicians.uploadPhoneApplicationPhoto(
        principal,
        parsed.data,
      ),
    };
  }
  @Post("documents")
  @Header("Cache-Control", "private, no-store")
  async document(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const parsed = TechnicianIdentityDocumentUploadSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        "请上传JPG或PNG身份证照片，单张不超过512KB",
      );
    return {
      data: await this.technicians.uploadPhoneIdentityDocument(
        principal,
        parsed.data,
      ),
    };
  }
  @Post("submit")
  @Header("Cache-Control", "private, no-store")
  async submit(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    this.empty(body);
    return { data: await this.technicians.submitPhoneApplication(principal) };
  }
  private empty(body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length
    )
      throw new BadRequestException("此请求不接受额外身份或组织参数");
  }
}
