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
import { MfaRecoveryController } from "./mfa-recovery.controller.js";
import { MfaRecoveryService } from "./mfa-recovery.service.js";
import { IntegrationsModule } from "../integrations/integrations.module.js";
import { PhoneVerificationSmsService } from "./phone-verification-sms.service.js";

@Module({
  imports: [IntegrationsModule],
  controllers: [
    AuthController,
    AuditController,
    MfaController,
    BrowserLoginController,
    MfaRecoveryController,
  ],
  providers: [
    AuthService,
    MfaService,
    BrowserLoginService,
    MfaRecoveryService,
    AuthCryptoService,
    WechatMiniappClient,
    SessionAuthGuard,
    AccessControlService,
    PhoneVerificationSmsService,
  ],
  exports: [
    AuthService,
    AuthCryptoService,
    SessionAuthGuard,
    AccessControlService,
  ],
})
export class AuthModule {}
