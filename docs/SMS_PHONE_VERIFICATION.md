# 阿里云短信手机号验证

## 已核验的阿里云资源

- 短信资质：`Novira短信资质`，审核通过。
- 短信签名：`昊云嘉科技`，状态正常，关联上述资质。
- 验证码模板：`中原到家登录验证`，模板编号 `SMS_512625587`，审核通过、状态正常。
- 模板变量：只允许 4–6 位 `code`，仅用于注册与手机号绑定。

该模板不得用于订单、安全告警、营销或其他内容。安全告警短信仍由
`SAFETY_NOTIFICATION_DISPATCH_ENABLED` 和独立模板控制，默认关闭。

## 服务端配置

真实值只写入服务器 `/etc/zhongyuan-daojia/api.env`，不要提交 Git、放入小程序或截图：

```dotenv
SMS_PROVIDER=aliyun
SMS_SEND_ENABLED=true
PHONE_VERIFICATION_SMS_ENABLED=true
ALIYUN_SMS_ACCESS_KEY_ID=<受限 RAM 身份>
ALIYUN_SMS_ACCESS_KEY_SECRET=<仅服务器保存>
ALIYUN_SMS_SIGN_NAME=昊云嘉科技
ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE=SMS_512625587

# 未完成安全告警模板与真人值班验收前保持关闭
SAFETY_NOTIFICATION_DISPATCH_ENABLED=false
SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED=false
ALIYUN_SMS_TEMPLATE_CODE=
```

推荐 RAM 身份只授予发送短信所需的最小权限，并设置费用/频率告警。应用包含用户每小时、手机号每日、60 秒重发冷却、5 分钟验证码失效和最多 5 次尝试限制；数据库只保存手机号密文、手机号哈希与验证码哈希。

## 小程序流程

1. 首次微信登录自动创建账号。
2. 优先使用微信官方 `getPhoneNumber` 完成手机号验证。
3. 官方授权不可用时，用户可选择短信备用验证。
4. 服务端验证完成后才允许提交订单。

上线前必须在受控测试号码上验证一次“申请验证码—收到短信—绑定成功”，并核对阿里云发送记录。未做真实测试时，不能把模板审核通过写成“短信发送已通过”。
