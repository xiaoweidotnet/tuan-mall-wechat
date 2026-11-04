# tuan-mall-server

微信团购商城（类快团团）MVP 后端，Node.js + Express + better-sqlite3，技术设计见 `../docs/design.md`。

## 运行

```bash
npm install
npm start          # 默认 :3000，数据库文件 server/data.sqlite
PORT=8080 DB_PATH=/tmp/tuan.sqlite npm start

# 微信授权登录（可选）：配置后走真实 jscode2session；不配置则用开发兜底 openid
WECHAT_APPID=touristappid WECHAT_SECRET=your-secret npm start
```

## 测试

```bash
npm test           # node:test + assert，独立 :memory: 数据库，不污染开发库
```

## API 概览（/api 前缀，除 auth 外均需 `Authorization: Bearer <token>`）

- `POST /api/auth/mock-login` `{nickname}` → `{token, user}`（开发用模拟登录）
- `POST /api/auth/wechat-login` `{code}`（小程序 `wx.login()` 得到的 code）→ `{token, user, profile_completed}`；按 openid 找/建用户，新用户 `profile_completed=false`，需完善资料
- `POST /api/auth/send-code` `{phone}` → `{sent, expires_in, provider}`（发送手机号登录验证码；5 分钟有效，同手机号 60 秒间隔、每小时最多 5 条，同 IP 每小时最多 20 条）
- `POST /api/auth/phone-login` `{phone, code}` → `{token, user, profile_completed}`（验证码一次性使用；手机号已存在则登录，否则自动建档）
- `PUT /api/users/me` `{nickname?, avatar_url?}` → `{user, profile_completed}`（完善/修改当前用户昵称、头像；nickname 1–20 字，avatar_url 为 `/uploads/…` 或 http(s) 地址）
- `GET/POST /api/products`，`GET/PUT /api/products/:id`
- `POST /api/groups`，`GET /api/groups`，`GET /api/groups/:id`（含 `sold_quantity`）
- `POST /api/groups/:id/close` 团长手动截团（与到期惰性结算同逻辑）
- `POST /api/groups/:id/orders` `{quantity, delivery_method, address|pickup_point_id}`
- `GET /api/orders?role=buyer|leader`
- `POST /api/orders/:id/pay|cancel|refund|refund/approve|ship|confirm-pickup|confirm-receipt`
- `GET/POST /api/pickup-points`

金额一律为整数分。

## 登录流程

小程序「微信授权登录」：`wx.login()` 拿 code → `POST /api/auth/wechat-login` → 后端换 openid（未配置 `WECHAT_APPID`/`WECHAT_SECRET` 时用 `dev_` 前缀兜底 openid）→ 按 openid 找/建用户并签发 token。

小程序「手机号登录」：输入手机号 → `POST /api/auth/send-code` → 输入 6 位验证码 → `POST /api/auth/phone-login` → 校验通过后按手机号找/建用户并签发同一格式 token。首次登录自动建档（`users.phone` 唯一），资料不完整时同样进入「完善资料」页。

- 资料完整（有昵称）：`profile_completed=true`，直接进入首页；
- 资料不完整（新用户昵称为空）：`profile_completed=false`，小程序跳转「完善资料」页，提交头像 + 昵称后调 `PUT /api/users/me` 补全，之后才能使用其他功能（`users.nickname` 非空即视为完整）。

## 短信验证码（开发 mock）

验证码 5 分钟有效、一次性使用，校验后同一手机号的其它未用验证码一并作废；库中只保存 HMAC，不落明文。

短信服务商与签名模板尚未确定，`SMS_PROVIDER` 默认 `mock`：验证码只打印到服务端日志，无外部依赖即可跑通。真实通道接入时实现 `src/services/sms.js` 的 provider 接口 `{ name, sendVerificationCode({ phone, code }) }`，并在 `createSmsService` 注册，路由层无需改动。

## 订单状态机

```
pending --pay--> paid --ship(express)--> shipped --confirm-receipt--> completed
paid    --confirm-pickup(pickup)--> completed
pending --cancel--> cancelled（回补库存）
paid    --refund--> refund_requested --refund/approve(仅团长)--> refunded（回补库存）
```

## 截团结算

读团购/订单接口时对到期团购做惰性结算（`src/services/settlement.js`）：
`target_quantity > 0` 且已售未达标 → `failed`，所有已支付订单自动退款并回补库存；否则 `succeeded`。

## 微信支付 v3 真实接入点

`src/services/payment.js` 当前为 mock 实现（直接成功）。真实接入时：

- `createPayment(order)` → 微信支付 v3「JSAPI/小程序下单」`POST /v3/pay/transactions/jsapi`，返回 `prepay_id` 供小程序 `wx.requestPayment` 调起；支付结果以异步回调通知（需验签）为准。
- `refund(order)` → `POST /v3/refund/domestic/refunds`。
- 需要配置：商户号 `mchid`、API v3 密钥、商户 API 证书私钥（建议走环境变量，不要入库/入仓）。
