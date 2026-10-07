import { Module } from "@nestjs/common";
import { AliyunSmsClient } from "./aliyun-sms.client.js";
import { AmapClient } from "./amap.client.js";

// Internal adapters only. Callers must own durable dispatch, retry and explicit send gates.
@Module({
  providers: [AliyunSmsClient, AmapClient],
  exports: [AliyunSmsClient, AmapClient],
})
export class IntegrationsModule {}
