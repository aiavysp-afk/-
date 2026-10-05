import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { IntegrationsModule } from "../integrations/integrations.module.js";
import { LocationsController } from "./locations.controller.js";
import { LocationsService } from "./locations.service.js";

@Module({
  imports: [AuthModule, IntegrationsModule],
  controllers: [LocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
