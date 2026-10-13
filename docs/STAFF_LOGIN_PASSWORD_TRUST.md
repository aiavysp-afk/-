# 工作人员双登录与常用设备

微信小程序身份确认和独立验证器动态码仍是默认主方式。账号密码登录是额外选项，账号使用后台人员已经验证的手机号，必须再验证发到该号码的短信。不会注册用户、创建工作人员角色或批准技师入驻申请。

## 验证边界

- 密码由账号本人在已完成有效 TOTP 的后台会话中设置；服务端仅保存独立随机盐的 scrypt 摘要。
- 短信挑战固定五分钟、一次性消费、最多五次错误，必须携带当前浏览器的随机挑战凭据。密码、手机号或工作人员资格变化使旧挑战失效。
- 密码加短信建立登录验证，不伪造或延长 TOTP 权限。
- 常用设备须本人在有效 TOTP 后主动登记，最多十台。HttpOnly、Secure、SameSite=Strict、无 Domain 的 host-only Cookie 只包含随机凭据；数据库仅存哈希。
- 设备信任固定七天，不滑动续期。它免除的是重复登录时的 TOTP，不能省略新的微信身份确认或账号密码加短信第一因子。
- 每次请求复核设备、账号、手机号、密码版本与验证器绑定版本。撤销设备或修改密码会使旧设备信任失效。
- 管理端读取允许有效登录验证；所有管理端 POST/PUT/PATCH/DELETE 及财务、权限管理操作仍要求当前有效 TOTP。服务端检查 Fastify 已解析路由，不依赖前端按钮状态。
- 组织权限仍来自当前 ACTIVE StaffMembership；不通过前端参数、设备 Cookie 或短信新增权限。

## 受控开关

`STAFF_PASSWORD_LOGIN_ENABLED`、`STAFF_TRUSTED_DEVICE_ENABLED` 默认都是 `false`，旧微信登录及现有会话字段不改变。

密码短信登录还须真实阿里云渠道就绪：`SMS_PROVIDER=aliyun`、`SMS_SEND_ENABLED=true`、`PHONE_VERIFICATION_SMS_ENABLED=true`，以及正确的发送凭据、签名和验证码模板。缺失时返回配置未就绪，禁止 Mock 代替真实短信。不得为了测试生产登录而发送短信给任意号码。

生产启用七天设备信任前，确认其只影响登录验证、不放宽敏感操作；首次密码设置、验证器绑定和验证码输入由本人完成，不能由代理代设或要求本人发送密钥。

新增迁移追加认证表与可空会话字段，并扩展现有会话来源约束：保留旧来源，仅允许后台浏览器使用新的密码登录来源。网关保持现有网络白名单，仅在具体 trusted-devices 路径转发一个合规设备 Cookie 与 User-Agent；其他 Cookie、任意上游 Set-Cookie 与宽泛认证路由仍被丢弃。

## 验收

单元回归覆盖密码错误锁定、短信失败及并发消费、设备到期和撤销、身份变更、权限隔离及 Cookie 代理边界。

`apps/api/scripts/verify-staff-password-trust.ts` 只接受 localhost 与 `zydj_staff_auth_acceptance_YYYYMMDD_*` 独立数据库，使用短信和微信内存替身验证真实 Prisma 事务。禁止指向正式库、使用生产凭据或输出密码、短信码及设备 token。

Windows 可运行 `scripts/verify-staff-auth-isolated.ps1 -SshKeyPath <部署密钥路径> -SshTarget <数据库主机SSH目标>`：创建独立临时数据库/最小权限登录角色，经本地 SSH 隧道迁移、验收，最后删除临时库和角色。它不使用正式数据库凭据，也不更改已有人员、权限、技师申请或账务记录。
