import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "./auth/auth.module.js";
import { CatalogModule } from "./catalog/catalog.module.js";
import { validateEnv } from "./config/env.js";
import { PrismaModule } from "./database/prisma.module.js";
import { OrdersModule } from "./orders/orders.module.js";
import { PaymentsModule } from "./payments/payments.module.js";
import { PublicController } from "./public/public.controller.js";
import { SchedulingModule } from "./scheduling/scheduling.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    AuthModule,
    CatalogModule,
    SchedulingModule,
    OrdersModule,
    PaymentsModule,
  ],
  controllers: [PublicController],
})
export class AppModule {}
