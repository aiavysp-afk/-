import { ConfigService } from "@nestjs/config";
import { PublicConfigSchema } from "@zydj/contracts";
import { describe, expect, it } from "vitest";
import { validateEnv, type AppEnv } from "../config/env.js";
import { PublicController } from "./public.controller.js";

describe("public configuration", () => {
  it("publishes the configured city but only advertises address search when its gate is open", () => {
    for (const enabled of ["false", "true"] as const) {
      const controller = new PublicController(
        new ConfigService<AppEnv, true>(
          validateEnv({
            SERVICE_CITY: "郑州市",
            MAP_PROVIDER: "tencent",
            MAP_GEOCODING_ENABLED: enabled,
          }),
        ),
      );
      const response = controller.publicConfig();
      expect(PublicConfigSchema.parse(response.data).serviceCity).toBe(
        "郑州市",
      );
      expect(response.data.features.addressSuggestionAvailable).toBe(
        enabled === "true",
      );
    }
  });
});
