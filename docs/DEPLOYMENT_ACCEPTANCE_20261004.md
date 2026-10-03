# 2026-10-04 服务器私有验收记录

结论：独立私有验收环境已部署并验证。**不是公网经营上线；真实微信支付、退款及自动关单恢复仍关闭。**原 mtsc.top 商城保持运行，没有旧业务数据迁移或真实资金操作。

## 实际版本与环境

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
