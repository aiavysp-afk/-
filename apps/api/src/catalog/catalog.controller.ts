import { Controller, Get, Param } from "@nestjs/common";
import { CatalogService } from "./catalog.service.js";

@Controller("catalog")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get("services")
  async listServices() {
    const data = await this.catalog.listPublished();
    return {
      data,
      meta: { total: data.length, currency: "CNY", moneyUnit: "fen" },
    };
  }

  @Get("services/:slug")
  async getService(@Param("slug") slug: string) {
    return { data: await this.catalog.getPublished(slug) };
  }

  @Get("services/:slug/reviews")
  async getServiceReviews(@Param("slug") slug: string) {
    const data = await this.catalog.listPublishedReviews(slug);
    return { data, meta: { total: data.length } };
  }
}
