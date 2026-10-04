# 小程序编译修复与联系渠道专项验收

日期：2026-10-04。本轮优先处理用户微信开发者工具“上传失败”截图；该失败的详细原因是WXML编译，不把它误当作已定位网络故障或已成功上传。

## 实际修复与验证

- 订单页和服务页空状态的wx:if使用了HTML转义的`&amp;&amp;`，微信WXML编译器将分号视作表达式语法错误。修改为空状态由TypeScript计算，WXML只绑定showEmptyOrders/showEmptyServices，重新生成运行JS。
- 本机微信开发者工具内置官方wcc.exe修复前复现orders/index.wxml Bad attr wx:if / unexpected semicolon；修复后全部8个商城页面编译exit 0，无诊断。开发者工具刷新后首页正常渲染。此结果证明WXML问题已消除，不证明上传/真机/支付验收完成。
- 5工作区typecheck通过；4项新增WXML/编译页面回归测试、5项客服原生接口替身测试及13项专项包边界测试通过。WXML回归加入CI，覆盖源码所有绑定、转义操作符、未登录/加载/失败/空分类状态；CI静态绑定检查不冒充官方WXML编译器。

## 本轮实际交付回执

- 功能提交：`3182c0601657603f580d7fda1f21d4efeb537bda`，已推送GitHub main；[CI run 37188558127](https://github.com/aiavysp-afk/-/actions/runs/37188558127) completed/success，含类型检查、构建、单元回归、PostgreSQL商城/微信支付数据库/MFA/恢复/浏览器登录集成自测。
- 已实际生成原始验收包：`D:\中原到家\.codex-runtime\miniapp-contact-acceptance\3182c0601657603f580d7fda1f21d4efeb537bda\`，精确12文件、7641字节。Manifest SHA256：`baa93beeb1ca8e4cb95ad23dc2b7212a2b290ec4f1dcf7cc360a03f2c9af194d`。独立只读审计逐项核对11个载荷文件哈希/字节、能力白名单和替身点击行为通过；此包未导入工具，保持原始内容。
- 该专项包单页经本机官方wcc.exe编译exit 0，无诊断。对包含的JS验证不自动调用，人工点击才打开客服/拨号入口；这不是微信真人接通证明。
- 为防止工具自动写入private-config污染原始清单，另复制本地工作副本：`D:\中原到家\.codex-runtime\miniapp-contact-preview\3182c0601657603f580d7fda1f21d4efeb537bda\`。现已导入工具，项目名`zhongyuan-daojia-contact-acceptance`，导入界面核对AppID正确；工具在副本内生成了`project.private.config.json`，副本不再是原始12文件交付包。
- 工具停在“您信任此项目的代码吗？/信任并运行”安全提示。电脑操作技能禁止代理代处理安全/权限提示；本人查看源码并自行决定信任后，才可正常编译和预览。本轮未点击信任、未生成预览二维码、未正式上传/审核/发布，也未实际拨号/发消息。
- 未切换服务器运行版本、未开放公网Mock接口、未开启真实资金/短信/地图开关；商城首页正常渲染不代表商品接口或经营全流程已在真机验收。

## 为什么使用单独的验收包

商城开发源码仍使用localhost开发API，私有服务仅回环；手机不能直接访问电脑localhost。不能为了扫码把test/Mock身份和资金接口开放公网。完整商城还存在未完工履约/演示UI/真实渠道及人工门禁，不上传为正式经营版。

专项包只有一页：已确认的企业微信公开CorpID/官方客服URL、商家值班手机号、用户点击触发的客服/拨号原生入口和失败提示。没有wx.request、wx.login、requestPayment、订单/支付/退款或Mock接口。页面明确标注“不是商城经营版”“打开入口不等于接通”“商家值班电话不是公共应急号码”。源码模板与测试没有实际联系方式，实际公开配置仅进入忽略目录的生成包。

生成器只读取字面127.0.0.1、明确端口、固定/v1/config/public，8秒限制、禁止跳转、64KiB流式响应边界；通过@zydj/contracts Schema验证就绪后仅复制挑选的公开字段。模板和helper须与当前commit一致；输出固定12文件白名单与SHA256清单，重复创建拒绝，不覆盖已有包。生成project.config.json域名校验开启、源码图关闭，无private-config/node_modules/TS/密钥。不能用此专项包覆盖正式商城体验版本。

## 生成与人工微信验收

1. 检查GitHub main对应提交CI通过、私有API公开配置客服available=true；保持公网503和真实资金/短信/地图开关false。服务器配置与联系人归属确认见SUPPORT_CHANNELS_IMPLEMENTATION。
2. 在仓库根目录执行`pnpm --filter @zydj/contracts build`，然后`pnpm package:contact-acceptance -- --port 5310`（也可直接`node scripts/package-contact-acceptance.mjs --port 5310`）。5310为既有SSH回环转发，不修改服务器公网访问。生成到`.codex-runtime/miniapp-contact-acceptance/<40位HEAD>/`。
3. 使用另一个本地工作副本导入微信开发者工具，避免工具自动生成文件改变原始清单。本轮已经导入上述`miniapp-contact-preview`副本；先本人处理项目安全提示，核验AppID及“联系渠道专项验收”标题，再只使用“预览”生成临时二维码。不要对完整商城源码执行正式上传，也不要提交审核/发布或修改生产域名/安全设置来绕过门禁。
4. 开发者必须已登录且有该AppID开发权限。微信扫码/身份校验由本人完成；不能让代理代做认证。CLI连接失败时使用正常工具预览UI或由用户检查工具状态，不绕过CLI权限或自动修改安全设置。
5. 两台微信真机人工点击客服，核验正确企业/客服账号、真实接通及失败回退；值班人员配合下人工验收拨号与无法接通兜底。自动化只做接口替身，不实际拨号或发送消息。记录系统/微信版本、时间、验证者、账号与通过/失败结果，不记录私人聊天内容。
6. 真人值班与主备岗/超时升级流程未完成前SAFETY_DUTY_CONFIRMED=false。原生窗口打开或SDK回调成功不等于求助已受理；本包不能提供自动安全告警闭环。

官方原始CLI/网络文档本轮读取受限；使用本机实际cli --help及wcc -h确认参数和行为，并参考[腾讯官方开发工具工作流说明](https://github.com/TencentCloudBase/skills/blob/main/skills/miniprogram-development/references/devtools-debug-preview.md)。本机CLI islogin未能连接IDE服务端口，不能据此断言账号未登录或自动预览成功。

## 改动文件与剩余人工项

- `.github/workflows/ci.yml`、`package.json`
- `apps/miniapp/pages/orders/index.ts`、生成JS、WXML
- `apps/miniapp/pages/services/index.ts`、生成JS、WXML
- `scripts/verify-miniapp-wxml.test.mjs`
- `scripts/package-contact-acceptance.mjs`、其测试
- `assets/contact-acceptance/`的8个白名单模板
- 本记录、README、CHANGE_FILES、SELF_TEST_REPORT、IMPLEMENTATION_STATUS

剩余：开发者权限/扫码预览、两台真机接通/拨号与响应演练、完整商城环境配置和发布打包、真实渠道/资金/履约/争议规则。此轮没有新的数据库迁移或服务器服务切换，也没有解除维护。
