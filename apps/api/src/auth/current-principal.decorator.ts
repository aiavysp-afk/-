import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { AuthPrincipal } from "./auth.types.js";

export type AuthenticatedRequest = FastifyRequest & {
  authPrincipal?: AuthPrincipal;
};

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthPrincipal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.authPrincipal) throw new Error("认证守卫未设置身份上下文");
    return request.authPrincipal;
  },
);
