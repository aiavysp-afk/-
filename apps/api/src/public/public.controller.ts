import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env.js';

@Controller()
export class PublicController {
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'zhongyuan-daojia-api', timestamp: new Date().toISOString() };
  }

  @Get('config/public')
  publicConfig() {
    const nodeEnv = this.config.get('NODE_ENV', { infer: true });
    return {
      data: {
        brandName: this.config.get('BRAND_NAME', { infer: true }),
        miniappAppId: this.config.get('WECHAT_MINIAPP_APP_ID', { infer: true }),
        officialAccountId: this.config.get('WECHAT_OFFICIAL_ACCOUNT_ID', { infer: true }),
        operatingMode: nodeEnv === 'production' ? 'PRODUCTION' : 'DEVELOPMENT',
        serviceCity: '试运营区域',
        safetyHotlineAvailable: Boolean(this.config.get('SAFETY_HOTLINE', { infer: true })),
        integrations: {
          payment: this.config.get('PAYMENT_PROVIDER', { infer: true }),
          sms: this.config.get('SMS_PROVIDER', { infer: true }),
          map: this.config.get('MAP_PROVIDER', { infer: true }),
        },
      },
    };
  }
}

