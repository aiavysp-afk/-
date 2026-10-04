import { Module } from "@nestjs/common";
import { AliyunSmsClient } from "./aliyun-sms.client.js";
import { TencentMapClient } from "./tencent-map.client.js";

// No HTTP endpoints or background sends until durable dispatch/rate-control is integrated.
@Module({
  providers: [AliyunSmsClient, TencentMapClient],
  exports: [AliyunSmsClient, TencentMapClient],
})
export class IntegrationsModule {}
