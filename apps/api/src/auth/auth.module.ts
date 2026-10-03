import { Module } from "@nestjs/common";
import { AccessControlService } from "./access-control.service.js";
import { AuditController } from "./audit.controller.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { SessionAuthGuard } from "./session-auth.guard.js";
import { WechatMiniappClient } from "./wechat-miniapp.client.js";

@Module({
  controllers: [AuthController, AuditController],
  providers: [
    AuthService,
    AuthCryptoService,
    WechatMiniappClient,
    SessionAuthGuard,
    AccessControlService,
  ],
  exports: [
    AuthService,
    AuthCryptoService,
    SessionAuthGuard,
    AccessControlService,
  ],
})
export class AuthModule {}
