# 2026-10-04 服务器私有验收记录

最新登录交接切片：源码与本机两库已进入第15批；本轮服务器只有只读容量/旧站/迁移核验，current仍2cda5189/14批/User0/Order0，旧站200与PID基线不变。可用3430204KiB，当前release399940KiB；新源码脚本保留3GiB运行余量加512MiB发布空间，容量不满足，所以没有上传/解压新release、改环境、执行远程第15批迁移或重启服务。没有清理旧数据。详见[当前交接交付](BROWSER_LOGIN_IMPLEMENTATION.md)。以下为上轮成功MFA部署记录，不是本轮交接部署成功。

本页首次部署数据保留作为历史基线；以下MFA更新为2026-10-04北京时间04:43的服务器实测。不能用源码或本地测试替代服务器验收。

结论：独立私有验收环境已部署并验证。**不是公网经营上线；真实微信支付、退款及自动关单恢复仍关闭。**原 mtsc.top 商城保持运行，没有旧业务数据迁移或真实资金操作。

## 当前MFA更新：已部署并验收

- 当前代码及release：`2cda5189484425c1a04a7a397ff06c97d1f97949`，current指向`/opt/zhongyuan-daojia-acceptance/releases/2cda5189484425c1a04a7a397ff06c97d1f97949`；[该提交GitHub CI](https://github.com/aiavysp-afk/-/actions/runs/37152238533)全部success，包含243项API+13项合约测试、6项预览安全测试、构建、14批迁移及三个HTTP/DB流程。
- 新归档SHA256：`e521cfa6eaeed4655f29d410eacc4d3a2c6161d9499e8e22563b9778d985379e`。相同源码及已构建dist打包，无运行密钥/.env/node_modules；脚本LF、服务范围和归档摘要均核验。
- 升级前只备份独立验收库，再应用`20261004031000_staff_mfa`；验收库与专用smoke库现有14批迁移全部成功。保留旧release和备份，不撤回migration；正式环境不得回滚到缺少MFA门禁的旧应用。
- 受控私有配置只新增`STAFF_MFA_REQUIRED=true`；自动逐项比对原配置，其余变量和随机密钥完全不变。NODE_ENV=test、AUTH/PAYMENT_PROVIDER=mock，三项真实微信资金开关仍false；没有为真实人员创建身份或绑定验证器。
- 实际运行API和两个同源代理均验证health/catalog为200、订单与MFA未登录401、敏感.env404。三个新服务active/running且仅监听127.0.0.1:3210/3212/3213；用户非root、资源和系统保护不变，实测内存约51/27/28MiB。
- 在`zydj_acceptance_smoke`运行商城全流程、支付并发/恢复、MFA实际HTTP/PostgreSQL验证均通过，三个脚本都报告合成数据已清理。覆盖单周期动态码防重放、并发一次提升、五次错误持久锁定、会话隔离/五分钟门禁、角色/组织分离、DB防改及三轮验证/注销竞态；没有真实微信登录或付款。
- Linux预览边界6项全部通过。验收库和smoke库最终User/Order/MfaCredential均0。更新后数据库备份成功恢复到全新`zydj_acceptance_restore_mfa_20261004`，14批迁移、3个服务及上述零记录完整，没有覆盖任何原有数据库。
- 用户电脑隧道health200；浏览器实测“账户安全”未登录保护及正式微信登录待接入提示，无错误/警告。截图仅保留本机`.codex-runtime/private-acceptance-mfa.png`，不提交仓库；不在浏览器中绑定真实MFA设备。
- 原jingxiang-api/admin的PID/ActiveState/WorkingDirectory仍与首次基线完全一致，https://mtsc.top/返回200；未修改DNS/Nginx/安全组/旧商城库/微信后台。数据库角色仍无superuser/createdb/createrole，配置640，备份600，时间同步NTPSynchronized=yes。

本次专用备份（仅root可读，不上传仓库）：

| 用途 | `/opt/zhongyuan-daojia-acceptance/backups/`下文件 | SHA256 |
| --- | --- | --- |
| 第14批迁移前 | `database-before-2cda5189484425c1a04a7a397ff06c97d1f97949-20261003T204035.dump` | `2c33006e77f5138899185f2b87c81138769e32f9ffc3363523a90f9e6997e84b` |
| 新版完整备份/恢复验证 | `acceptance-mfa-2cda5189-after-tests.dump` | `99eb28dbb654081a4f083085687c968dbda114b71779230f88a4f6f3b1172621` |

配置升级前备份为`api-env-before-mfa-2cda5189`；三个流程的脱敏日志也在同一专用backups目录。磁盘仍93%，实测剩余3434292KiB，约3.28GiB；未删除旧文件，下一次部署仍执行大于3GiB停止门禁。不得把当前私有验证等同正式经营上线。

**下一切片：正式微信到后台浏览器的安全登录/会话交接；之后真人独立设备验收及丢失设备的双人受审恢复。**MFA基础完成，但这些阻断未解除，不能用Mock登录或共享密钥代替。

## 首次部署历史基线与环境

- 服务器：120.55.187.102，Ubuntu24.04；沿用本机 PostgreSQL16.15，但只新建独立角色和数据库。
- 部署代码提交：`a524c984044b08a48b6250907d83f54b951a1c13`；支付补偿功能提交：`6ea1f70ad65617c915146b0197d9eb6d15e05c08`。后续验收文档提交不改变此部署代码。
- 两个代码提交的 GitHub CI 全部成功：[功能验证](https://github.com/aiavysp-afk/-/actions/runs/37146204728)、[部署包换行验证](https://github.com/aiavysp-afk/-/actions/runs/37146443414)。包含230项API/合约测试、6项预览安全测试、构建、迁移及HTTP/数据库验证；不是230项真机测试。
- release：`/opt/zhongyuan-daojia-acceptance/releases/a524c984044b08a48b6250907d83f54b951a1c13`；current指向此目录。OWNER和DEPLOY_COMMIT均校验。
- 部署归档SHA256：`bcb955c44dd849ec21bcae91685cd02cc6d98b220869dfcf5b3683a1f11abe13`。归档无运行.env、node_modules、钥证；Linux脚本LF已复核。
- 独立Node24.19.0（下载后按官方SHA256校验）、pnpm11.19.0；不替换系统Node22或pnpm12。
- 独立服务用户`zydj-acceptance`，数据库角色`zydj_acceptance`无superuser/createdb/createrole，连接上限20。
- 数据库`zydj_acceptance`完整13批migration成功，目录3个项目；验收后User/Order均0。未种固定运营或财务身份。
- `/etc/zhongyuan-daojia-acceptance/api.env`为640、root:zydj-acceptance；随机生成密码、pepper和加密密钥，仅留服务器，不打印/提交。
- NODE_ENV=test、AUTH/PAYMENT/SMS/MAP_PROVIDER=mock，三个WECHAT_PAY开关false。没有复用旧商户钥证发起交易。

## 服务与访问

三个新systemd服务`zhongyuan-daojia-acceptance-api/admin/h5`均active/running，开机自启，只监听127.0.0.1的3210/3212/3213；用户非root、ProtectSystem=strict、ProtectHome/PrivateTmp/NoNewPrivileges已设置。API内存上限512MiB、CPU50%；两项预览各128MiB/25%。最终实测内存约51/28/28MiB。

用户电脑SSH隧道已建立，本机也只监听127.0.0.1：

- [API健康检查](http://127.0.0.1:5310/v1/health)
- [后台私有验收](http://127.0.0.1:5312/)：目录真实读取验收数据库；未登录只读，退款复核提示无财务权限；没有开发固定身份登录按钮。
- [技师H5视觉预览](http://127.0.0.1:5313/)：仍为明确标识的演示，不代表已接真实履约。

这些地址仅在本电脑隧道存活时可用，不是公网网址。电脑重启/隧道退出后需重新建立；服务器服务仍运行。可用已有授权私钥重连（不复制密钥到聊天/仓库）：

```powershell
$privateSshArgs=@('-N','-i','<授权私钥绝对路径>','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-L','127.0.0.1:5310:127.0.0.1:3210','-L','127.0.0.1:5312:127.0.0.1:3212','-L','127.0.0.1:5313:127.0.0.1:3213','root@120.55.187.102')
# 先确认三个本机端口未被其他进程占用；不要重复启动。
Start-Process -FilePath (Get-Command ssh).Source -ArgumentList $privateSshArgs -WindowStyle Hidden
```

## 服务器实际验收结果

1. 运行中API及两个同源预览代理均返回3个正确服务；未登录订单接口401；敏感.env访问404；本机隧道健康200。浏览器实际验证目录价格¥198/268/198、未登录退款权限提示和H5演示标识。
2. 独立验收库pg_dump自定义备份成功，文件600 root:root；通过标准输入恢复到全新`zydj_acceptance_smoke`，13批迁移和3个目录项目完整。
3. 在smoke库运行实际HTTP商城流程：登录/禁用账号/鉴权、商品详情/排班/报价、加密地址、并发幂等下单、Mock支付、订单取消/登出、退款额度/自审拒绝/独立复核/并发/历史/DB约束、编译后小程序JS逻辑均通过。
4. 在smoke库运行支付数据库验证：并发通知一次计账、单次预下单、未知结果不重发、双实例恢复租约、原单查单/关单/再核实、关单超时保留HOLD、到账与关单竞态、迟到支付人工复核、最后lease崩溃单次升级、退款不重复POST/记账均通过。微信SDK、钥证、网络和渠道是隔离替身，**没有真机付款或实际退款到账**。
5. Linux下6项静态预览安全测试通过。两个流程脚本均报告syntheticFixturesRemoved=true；smoke库最终User/Order均0。
6. 原jingxiang-api/admin的PID/ActiveState/WorkingDirectory与部署前基线完全一致；主站https://mtsc.top/仍200。未改DNS、Nginx、安全组、原商城数据库或微信后台。

备份位置：`/opt/zhongyuan-daojia-acceptance/backups/acceptance-a524c984-before-tests.dump`；SHA256 `4f97b8f5ed99ae065caaac6ff2093e3ed738f858dcad8b1709c46b12858667c2`。旧Nginx配置备份、服务基线、脱敏测试输出也留在本项目backups中，仅root读取；不上传公共仓库。

权限问题曾阻止postgres直接读取root备份，改为root打开文件后经stdin交给pg_restore，**未放宽备份目录权限**。首次Windows归档换行错误在安装前停止，加入.gitattributes后新包验证成功。失败尝试的独立release/归档保留以供核查，无服务引用，无删除旧业务文件。

## 运维风险与停止方式

最终磁盘49GiB、使用93%、剩余约3.49GiB，已接近容量警戒；没有自行删除旧项目/备份。不在此机器做大量重复构建、长期压测或正式经营扩容，需负责人先确认容量治理方案。

只停止本项目验收服务，不影响旧商城：

```bash
systemctl stop zhongyuan-daojia-acceptance-{api,admin,h5}.service
# 需要取消新服务开机自启时，只disable相同三个验收服务；保留数据库与release。
```

已有专用数据库、备份和配置不删除。应用回滚只切换本项目current到兼容release，不自动撤回migration，不向旧商城库恢复任何备份。

## 公网/真实资金上线前人工核对

- [ ] 经营主体、首发城市、服务区域/资质、非医疗服务边界、正式价格/差旅费、协议/隐私/保险和退款规则经负责人确认。
- [ ] 小程序/公众号/商户主体和AppID绑定在官方后台确认；正式HTTPS合法域名及支付/退款通知可达。
- [ ] 正式后台登录/MFA、两个不同自然人的申请/复核角色及异常人工修正流程上线，不用共享账号或开发身份代替。
- [ ] 真机登录、受控小额支付/退款到账、通知验签、跨日账单及异常/崩溃恢复由资金责任人验收。
- [ ] 技师真实排班/履约、短信/地图、客服/SOS/值班热线和outbox投递/告警完成。
- [ ] 服务器容量、正式备份保留/异机恢复、密钥轮换、维护窗口与回滚责任人确认。

以上无法通过“全面授权”替代真实身份、经营规则或渠道验收；未完成前不替换主站、不上传正式经营版小程序、不打开真实资金开关。完整生产步骤见[部署文档](DEPLOYMENT.md)，变量与DB脚本见[变量清单](ENV_VARIABLES.md)及[初始化SQL](../infra/database-init.sql)。
