import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AddressSuggestionQuerySchema } from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { LocationsService } from "./locations.service.js";

@Controller("locations")
@UseGuards(SessionAuthGuard)
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get("address-suggestions")
  async suggest(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: unknown,
  ) {
    const parsed = AddressSuggestionQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("地址关键词无效");
    const data = await this.locations.suggest(principal, parsed.data.keyword);
    return { data, meta: { total: data.length } };
  }
}
