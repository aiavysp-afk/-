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

export function customerSmsRouteAllowed(method: string, route: string) {
  const path = route.replace(/^\/v1(?=\/)/, "").split("?")[0];
  const verb = method.toUpperCase();
  // Deliberately enumerate customer resource families rather than deny only
  // today's staff paths. A future staff capability is not implicitly granted
  // merely because an existing phone customer also has a staff membership.
  if (
    (path === "/auth/me" && verb === "GET") ||
    (path === "/auth/logout" && verb === "POST")
  )
    return true;
  if (
    /^\/(?:orders|customer-center|booking-holds|locations|friend-payments)(?:\/|$)/.test(
      path ?? "",
    )
  )
    return true;
  if (path === "/payments/notifications" && verb === "GET") return true;
  return (
    verb === "GET" &&
    /^\/(?:catalog|availability|technicians)(?:\/|$)/.test(path ?? "")
  );
}

export function technicianPhoneRouteAllowed(
  method: string,
  route: string,
  workbench: boolean,
) {
  const path = route.replace(/^\/v1(?=\/)/, "").split("?")[0] ?? "";
  const verb = method.toUpperCase();
  if (
    (path === "/auth/me" && verb === "GET") ||
    (path === "/auth/logout" && verb === "POST")
  )
    return true;
  if (path === "/technician/phone-onboarding/status") return verb === "GET";
  if (path === "/technician/phone-onboarding/profile") return verb === "PATCH";
  if (
    /^\/technician\/phone-onboarding\/(?:register|photos|documents|submit)$/.test(
      path,
    )
  )
    return verb === "POST";
  if (
    /^\/technician\/workbench\/profile\/photos\/(?:[A-Za-z0-9-]+|:photoId)$/.test(
      path,
    )
  )
    return verb === "GET";
  if (!workbench) return false;
  if (path === "/technician/workbench/profile")
    return ["GET", "PATCH"].includes(verb);
  if (/^\/technician\/workbench\/profile\/(?:submit-review|photos)$/.test(path))
    return verb === "POST";
  if (/^\/technician\/workbench(?:\/earnings)?$/.test(path))
    return verb === "GET";
  if (path === "/technician/workbench/location") return verb === "POST";
  if (
    /^\/technician\/workbench\/orders\/(?:[A-Za-z0-9_-]+|:orderId)\/route$/.test(
      path,
    )
  )
    return verb === "GET";
  if (
    /^\/technician\/workbench\/orders\/(?:[A-Za-z0-9_-]+|:orderId)\/actions$/.test(
      path,
    )
  )
    return verb === "POST";
  // Photo reads are needed to preview the applicant's unpublished owner image.
  return false;
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
    if (
      (request.authPrincipal.authChannel === "TECHNICIAN_PHONE" ||
        request.authPrincipal.authProvider === "technician-sms") &&
      (this.config?.get("TECHNICIAN_PHONE_LOGIN_ENABLED") !== "true" ||
        !technicianPhoneRouteAllowed(
          request.method,
          request.routeOptions?.url ?? request.url,
          this.config?.get("TECHNICIAN_PHONE_WORKBENCH_ENABLED") === "true" &&
            request.authPrincipal.memberships.some(
              (row) => row.role === "THERAPIST",
            ),
        ))
    )
      throw new ForbiddenException(
        "此登录仅可用于本人技师入驻及已审核的本人服务",
      );
    if (
      (request.authPrincipal.authProvider === "customer-sms" ||
        request.authPrincipal.authChannel === "CUSTOMER_SMS") &&
      !customerSmsRouteAllowed(
        request.method,
        request.routeOptions?.url ?? request.url,
      )
    )
      throw new ForbiddenException(
        "手机号登录仅用于客户业务，工作人员功能请切换微信一键登录",
      );
    // Use Fastify's resolved route, not a caller-controlled URL spelling. A
    // seven-day remembered device does not authorize an admin mutation.
    if (
      (this.config?.get("NODE_ENV") === "production" ||
        this.config?.get("STAFF_MFA_REQUIRED") === "true" ||
        request.authPrincipal.staffVerificationMethod === "PASSWORD_SMS" ||
        request.authPrincipal.staffVerificationMethod === "TRUSTED_DEVICE") &&
      request.authPrincipal.authChannel === "ADMIN_BROWSER" &&
      requiresAdminStepUp(
        request.method,
        request.routeOptions?.url ?? request.url,
      ) &&
      (!request.authPrincipal.mfaVerifiedUntil ||
        request.authPrincipal.mfaVerifiedUntil.getTime() <= Date.now())
    ) {
      throw new ForbiddenException("此敏感操作需要先在账户安全完成动态码验证");
    }
    return true;
  }
}
