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
import { WechatH5Client } from "./wechat-h5.client.js";
import { TechnicianH5AuthService } from "./technician-h5-auth.service.js";
import { TechnicianH5AuthController } from "./technician-h5-auth.controller.js";

@Module({
  imports: [IntegrationsModule],
  controllers: [
    AuthController,
    AuditController,
    MfaController,
    BrowserLoginController,
    MfaRecoveryController,
    TechnicianH5AuthController,
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
    WechatH5Client,
    TechnicianH5AuthService,
  ],
  exports: [
    AuthService,
    AuthCryptoService,
    SessionAuthGuard,
    AccessControlService,
  ],
})
export class AuthModule {}
