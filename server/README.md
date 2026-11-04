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
- `PUT /api/users/me` `{nickname?, avatar_url?}` → `{user, profile_completed}`（完善/修改当前用户昵称、头像；nickname 1–20 字，avatar_url 为 `/uploads/…` 或 http(s) 地址）
- `GET/POST /api/products`，`GET/PUT /api/products/:id`
- `POST /api/groups`，`GET /api/groups`，`GET /api/groups/:id`（含 `sold_quantity`）
- `POST /api/groups/:id/close` 团长手动截团（与到期惰性结算同逻辑）
- `POST /api/groups/:id/orders` `{quantity, delivery_method, address|pickup_point_id}`
- `GET /api/orders?role=buyer|leader`
- `POST /api/orders/:id/pay|cancel|refund|refund/approve|ship|confirm-pickup|confirm-receipt`
- `GET/POST /api/pickup-points`

### 秒杀

- `GET /api/seckill/activities` 已发布活动列表（含 `status`、`remaining_stock`、`server_time`、商品信息）
- `GET /api/seckill/activities/:id` 活动详情（未开始/进行中/已售罄/已结束，倒计时以 `server_time` 校准）
- `POST /api/seckill/activities/:id/orders` `{quantity, request_id, delivery_method, address|pickup_point_id}`：秒杀下单，成功返回 201；同一用户同一活动重复提交同一 `request_id` 返回原订单 200
- `GET /api/seckill/orders`，`GET /api/seckill/orders/:id`
- `POST /api/seckill/orders/:id/pay|cancel`：支付幂等；取消仅限待支付，取消后释放活动库存
- 运营接口（`x-admin-token` 保护）：
  - `GET/POST /api/admin/seckill/activities`，`PUT /api/admin/seckill/activities/:id`
  - `POST /api/admin/seckill/activities/:id/publish|terminate`
  - `GET /api/admin/seckill/activities/:id/stats`（下单量、支付量、剩余库存、转化率、售罄时间、异常数、事件计数）
  - `GET /api/admin/seckill/activities/:id/logs`（创建/修改/发布/终止及异常退款操作日志）

秒杀规则要点：

- 活动库存独立于商品库存，`sold` 表示已锁定数量；下单在事务内按 `sold + quantity <= stock` 条件扣减，失败即售罄，防止超卖。
- 限购按用户在同一活动的 `pending/paid` 订单累计，取消/超时后释放额度。
- 待支付订单超过 `pay_timeout_minutes`（默认 15 分钟）后，读取订单/活动/运营数据时惰性取消并释放库存。
- 支付回调对秒杀订单幂等；订单已取消或超时后又收到成功通知时自动退款并记录异常，供人工核对。

金额一律为整数分。

## 登录流程

小程序「微信授权登录」：`wx.login()` 拿 code → `POST /api/auth/wechat-login` → 后端换 openid（未配置 `WECHAT_APPID`/`WECHAT_SECRET` 时用 `dev_` 前缀兜底 openid）→ 按 openid 找/建用户并签发 token。

- 资料完整（有昵称）：`profile_completed=true`，直接进入首页；
- 资料不完整（新用户昵称为空）：`profile_completed=false`，小程序跳转「完善资料」页，提交头像 + 昵称后调 `PUT /api/users/me` 补全，之后才能使用其他功能（`users.nickname` 非空即视为完整）。

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
