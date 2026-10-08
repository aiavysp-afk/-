import "reflect-metadata";
import helmet from "@fastify/helmet";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import type { AppEnv } from "./config/env.js";
import { HttpExceptionTelemetryFilter } from "./observability/http-exception.filter.js";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true, trustProxy: true }),
    { rawBody: true },
  );
  const config = app.get<ConfigService<AppEnv, true>>(ConfigService);
  await app.register(helmet, { contentSecurityPolicy: false });
  app.useGlobalFilters(new HttpExceptionTelemetryFilter());
  app.setGlobalPrefix("v1");
  app.enableCors({
    origin: config
      .get("CORS_ORIGINS", { infer: true })
      .split(",")
      .map((item) => item.trim()),
    credentials: true,
  });
  const port = Number(config.get("API_PORT"));
  app.enableShutdownHooks();
  await app.listen(port, config.get("API_HOST", { infer: true }));
}

void bootstrap();
