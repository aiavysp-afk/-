import { Module } from "@nestjs/common";
import { AliyunSmsClient } from "./aliyun-sms.client.js";
import { TencentMapClient } from "./tencent-map.client.js";

// Internal adapters only. Callers must own durable dispatch, retry and explicit send gates.
@Module({
  providers: [AliyunSmsClient, TencentMapClient],
  exports: [AliyunSmsClient, TencentMapClient],
})
export class IntegrationsModule {}
