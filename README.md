# 微信团购商城 · 安全审计演示

此快照有意保留安全缺陷，仅用于代码审计与隔离的本地测试。勿部署到公网，勿接入真实账户、密钥、订单或支付。

# 团购商城 MVP（类快团团）

微信社群团购商城最小可行产品：微信小程序原生前端 + Node.js/Express + SQLite 后端。

- 调研与设计文档：`docs/kuaituantuan-research.md`、`docs/design.md`
- 后端：`server/`（详见 `server/README.md`）
- 小程序：`miniprogram/`

## 一期功能

- 核心闭环：mock 微信登录 / 手机号验证码登录 → 发布商品/开团 → 参团下单 → 模拟支付 → 快递发货/自提核销 → 退款售后
- 截团：到期自动结算；未达成团目标自动退款（补齐快团团无此机制的短板）
- 营销：秒杀（开始时间校验）、满减（降序取档）、单商品限购
- 履约：快递发货、自提点管理
- 不做（二期）：帮卖/佣金分销、直播、抽奖、一件代发、真实微信支付

## 本地启动

```bash
# 1. 启动后端（默认 :3000，SQLite 文件为 server/data.sqlite）
cd server
npm install
npm start

# 2. 运行测试（内存库，覆盖主流程）
npm test
```

```bash
# 3. 导入小程序
# 微信开发者工具 → 导入 miniprogram/ 目录
# 后端地址在 miniprogram/utils/config.js 的 baseURL（默认 http://localhost:3000/api）
```

主流程验证：`cd server && npm test` 退出码 0 即代表「开团→参团→模拟支付→订单→退款」全链路（含快递与自提两条履约路径、未成团自动退款）通过。

## 外部资质说明（模拟实现）

| 环节 | 现状 | 真实接入需要 |
| --- | --- | --- |
| 微信登录 | mock 昵称登录 | 小程序 AppID/AppSecret，`code2session` |
| 短信验证码登录 | mock provider，验证码只输出到服务端日志（`server/src/services/sms.js` 预留接口） | 短信服务商、签名与模板（阿里云/腾讯云等） |
| 微信支付 | mock 直接成功（`server/src/services/payment.js` 预留接口） | 微信商户号、API v3 密钥、商户证书 |
| 微信开发者工具 | 工程可导入，`project.config.json` 已关闭 urlCheck 便于连 localhost | 正式 AppID |
