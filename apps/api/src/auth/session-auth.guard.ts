import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "./auth.service.js";
import type { AuthenticatedRequest } from "./current-principal.decorator.js";

export function requiresAdminStepUp(method: string, route: string) {
  return (
    /^\/(?:v1\/)?admin(?:\/|$)/.test(route) &&
    !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())
  );
}

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match?.[1]) throw new UnauthorizedException("请先登录");
    request.authPrincipal = await this.auth.authenticate(match[1]);
    // Use Fastify's resolved route, not a caller-controlled URL spelling. A
    // seven-day remembered device does not authorize an admin mutation.
    if (
      (this.config?.get("NODE_ENV") === "production" ||
        this.config?.get("STAFF_MFA_REQUIRED") === "true" ||
        request.authPrincipal.staffVerificationMethod === "PASSWORD_SMS" ||
        request.authPrincipal.staffVerificationMethod === "TRUSTED_DEVICE") &&
      request.authPrincipal.authChannel === "ADMIN_BROWSER" &&
      requiresAdminStepUp(request.method, request.routeOptions?.url ?? request.url) &&
      (!request.authPrincipal.mfaVerifiedUntil ||
        request.authPrincipal.mfaVerifiedUntil.getTime() <= Date.now())
    ) {
      throw new ForbiddenException("此敏感操作需要先在账户安全完成动态码验证");
    }
    return true;
  }
}
