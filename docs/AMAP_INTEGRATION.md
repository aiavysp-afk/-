# 高德地图接入说明

本项目地图供应商为高德，业务坐标统一使用 `GCJ-02`。源码和文档不记录真实 Key 值。

## 环境变量

API 运行环境配置以下变量：

| 变量                            | 用途                           | 暴露范围                         |
| ------------------------------- | ------------------------------ | -------------------------------- |
| `MAP_PROVIDER=amap`             | 选择高德地图适配器             | 服务端                           |
| `MAP_GEOCODING_ENABLED=true`    | 开启地址搜索、逆解析和路线计算 | 服务端                           |
| `AMAP_MINIAPP_KEY`              | 微信小程序平台 Key             | 仅通过公开配置下发给小程序       |
| `AMAP_WEB_SERVICE_KEY`          | Web 服务 API 后端 Key          | 只存在受控服务器环境文件，不下发 |
| `SERVICE_AREA_ADCODE_ALLOWLIST` | 郑州服务范围六位行政区代码     | 服务端                           |

变量样例位于项目根目录 `.env.example`，真实值只写入被 `.gitignore` 排除的 `.env` 或服务器 `api.env`。

## 微信小程序后台

在“开发管理 → 开发设置 → 服务器域名”的 `request合法域名` 中保留：

- `https://restapi.amap.com`

已不再使用的地图供应商域名应删除。小程序 `app.json` 同时声明 `scope.userLocation` 和 `getLocation`。

## 业务链路

1. 小程序调用 `wx.getLocation({ type: "gcj02" })`。
2. 小程序使用前端 Key 和高德微信小程序协议参数调用逆解析或 POI 输入提示，用户人工核对门牌号。
3. API 使用后端 Key 再次逆解析坐标，校验行政区白名单，把地址文本和坐标绑定到短期核验凭证。
4. 下单保存加密地址及 GCJ-02 经纬度。
5. 技师端将浏览器 WGS-84 定位转为 GCJ-02 后上报，API 调用高德驾车路线接口返回距离和预计时长。
6. 技师端通过高德 URI 导航打开导航；用户只在技师已出发/已到达阶段查看技师位置状态。

页面会区分定位拒绝、网络/渠道错误、调用超限和位置过期。后端不返回高德原始错误体或后端 Key。

两个 Key 必须分别绑定“微信小程序”和“Web 服务”平台。接口返回 `10009` 表示 Key 绑定平台不匹配，不应通过互换或复用 Key 绕过。

如果任一 Key 的平台尚未修正，可以先保存两个变量并设置 `MAP_PROVIDER=amap`，但必须继续保持 `MAP_GEOCODING_ENABLED=false`；平台修正且真实接口验证通过后再打开门禁。

## 验证

- 无真实 Key：`pnpm typecheck && pnpm test && pnpm build`
- 受控真实高德验收：仅对隔离测试数据库运行 `RUN_REAL_AMAP_FLOW=true pnpm --filter @zydj/api test:mall`，并从受控环境提供两个 Key。

正式发布前必须再检查 Key 绑定平台/白名单、高德配额监控、小程序隐私保护指引与真机授权提示。
