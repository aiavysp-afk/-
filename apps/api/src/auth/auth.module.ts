import { Module } from "@nestjs/common";
import { AccessControlService } from "./access-control.service.js";
import { AuditController } from "./audit.controller.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { SessionAuthGuard } from "./session-auth.guard.js";
import { WechatMiniappClient } from "./wechat-miniapp.client.js";
import { MfaController } from "./mfa.controller.js";
import { MfaService } from "./mfa.service.js";
import { BrowserLoginService } from "./browser-login.service.js";
import { BrowserLoginController } from "./browser-login.controller.js";

@Module({
  controllers: [AuthController, AuditController, MfaController, BrowserLoginController],
  providers: [
    AuthService,
    MfaService,
    BrowserLoginService,
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
