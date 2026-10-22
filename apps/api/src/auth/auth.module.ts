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
import { StaffPasswordController } from "./staff-password.controller.js";
import { StaffPasswordService } from "./staff-password.service.js";
import { StaffPasswordSetupController } from "./staff-password-setup.controller.js";
import { StaffPasswordSetupService } from "./staff-password-setup.service.js";
import { TrustedDeviceController } from "./trusted-device.controller.js";
import { TrustedDeviceService } from "./trusted-device.service.js";
import { CustomerLoginController } from "./customer-login.controller.js";
import { CustomerLoginService } from "./customer-login.service.js";
import { CustomerPhoneIdentityService } from "./customer-phone-identity.service.js";
import { TechnicianPhoneAuthController } from "./technician-phone-auth.controller.js";
import { TechnicianPhoneAuthService } from "./technician-phone-auth.service.js";

@Module({
  imports: [IntegrationsModule],
  controllers: [
    AuthController,
    AuditController,
    MfaController,
    BrowserLoginController,
    MfaRecoveryController,
    TechnicianH5AuthController,
    StaffPasswordController,
    StaffPasswordSetupController,
    TrustedDeviceController,
    CustomerLoginController,
    TechnicianPhoneAuthController,
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
    StaffPasswordService,
    StaffPasswordSetupService,
    TrustedDeviceService,
    CustomerLoginService,
    CustomerPhoneIdentityService,
    TechnicianPhoneAuthService,
  ],
  exports: [
    AuthService,
    AuthCryptoService,
    SessionAuthGuard,
    AccessControlService,
  ],
})
export class AuthModule {}
