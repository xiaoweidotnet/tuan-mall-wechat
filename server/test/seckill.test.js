const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, api, login, adminApi, setupSeckill, seckillOrder } = require('./helpers');

function inFuture(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function createDraft(base, productId, overrides = {}) {
  return adminApi(base, {
    method: 'POST',
    path: '/api/admin/seckill/activities',
    body: {
      product_id: productId,
      seckill_price: 1990,
      stock: 5,
      start_at: new Date(Date.now() + 60_000).toISOString(),
      end_at: inFuture(120),
      limit_per_user: 1,
      ...overrides,
    },
  });
}

test('活动状态随服务端时间变化，未开始下单被拒、开始后可下单', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { activity } = await setupSeckill(base, leader.token, {
    startAt: inFuture(60),
    endAt: inFuture(120),
  });

  const detail = await api(base, {
    path: `/api/seckill/activities/${activity.id}`,
    token: buyer.token,
  });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.status, 'not_started');
  assert.equal(detail.body.can_buy, false);
  assert.ok(detail.body.server_time);
  assert.equal(detail.body.remaining_stock, 5);

  const early = await seckillOrder(base, buyer.token, activity.id);
  assert.equal(early.status, 400);
  assert.equal(early.body.code, 'NOT_STARTED');

  // 运营把开始时间改到过去（关键变更写入操作日志）
  const updated = await adminApi(base, {
    method: 'PUT',
    path: `/api/admin/seckill/activities/${activity.id}`,
    body: { start_at: new Date(Date.now() - 60_000).toISOString() },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.status, 'ongoing');
  assert.equal(updated.body.can_buy, true);

  const ok = await seckillOrder(base, buyer.token, activity.id);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.status, 'pending');
  assert.equal(ok.body.pay_amount, 1990);
  assert.equal(ok.body.unit_price, 1990);
  assert.ok(Date.parse(ok.body.expires_at) > Date.now());
});

test('活动结束后详情为 ended 且下单被拒；草稿活动对用户不可见', async (t) => {
  const { server, base, db } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { activity } = await setupSeckill(base, leader.token);
  db.prepare('UPDATE seckill_activities SET end_at = ? WHERE id = ?').run(
    new Date(Date.now() - 1000).toISOString(),
    activity.id
  );

  const detail = await api(base, {
    path: `/api/seckill/activities/${activity.id}`,
    token: buyer.token,
  });
  assert.equal(detail.body.status, 'ended');
  const res = await seckillOrder(base, buyer.token, activity.id);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'ENDED');

  // 草稿活动用户侧 404
  const { activity: draft } = await setupSeckill(base, leader.token, { publish: false });
  const hidden = await api(base, {
    path: `/api/seckill/activities/${draft.id}`,
    token: buyer.token,
  });
  assert.equal(hidden.status, 404);
  const draftOrder = await seckillOrder(base, buyer.token, draft.id);
  assert.equal(draftOrder.status, 400);
});

test('库存售罄后返回已抢光，且不超卖', async (t) => {
  const { server, base, db } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyers = await Promise.all([login(base, '买家1'), login(base, '买家2'), login(base, '买家3')]);
  const { activity } = await setupSeckill(base, leader.token, {
    activity: { stock: 2, limit_per_user: 1 },
  });

  const first = await seckillOrder(base, buyers[0].token, activity.id);
  const second = await seckillOrder(base, buyers[1].token, activity.id);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const detail = await api(base, {
    path: `/api/seckill/activities/${activity.id}`,
    token: buyers[2].token,
  });
  assert.equal(detail.body.status, 'sold_out');
  assert.equal(detail.body.remaining_stock, 0);
  assert.equal(detail.body.can_buy, false);

  const third = await seckillOrder(base, buyers[2].token, activity.id);
  assert.equal(third.status, 400);
  assert.equal(third.body.code, 'SOLD_OUT');
  assert.equal(
    db.prepare('SELECT sold FROM seckill_activities WHERE id = ?').get(activity.id).sold,
    2
  );

  const stats = await adminApi(base, {
    path: `/api/admin/seckill/activities/${activity.id}/stats`,
  });
  assert.equal(stats.body.events.sold_out, 1);
  assert.equal(stats.body.metrics.remaining_stock, 0);
});

test('限购按用户累计，取消订单后额度与库存一起释放', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { activity } = await setupSeckill(base, leader.token, {
    activity: { stock: 5, limit_per_user: 1 },
  });

  const first = await seckillOrder(base, buyer.token, activity.id);
  assert.equal(first.status, 201);

  const second = await seckillOrder(base, buyer.token, activity.id);
  assert.equal(second.status, 400);
  assert.equal(second.body.code, 'LIMIT_EXCEEDED');

  const cancelled = await api(base, {
    method: 'POST',
    path: `/api/seckill/orders/${first.body.id}/cancel`,
    token: buyer.token,
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');

  const retry = await seckillOrder(base, buyer.token, activity.id);
  assert.equal(retry.status, 201);
});

test('同一 request_id 重复提交只产生一张订单', async (t) => {
  const { server, base, db } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { activity } = await setupSeckill(base, leader.token);

  const requestId = 'fixed-request-id-1';
  const first = await seckillOrder(base, buyer.token, activity.id, { request_id: requestId });
  const second = await seckillOrder(base, buyer.token, activity.id, { request_id: requestId });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(first.body.id, second.body.id);

  const count = db
    .prepare('SELECT COUNT(*) AS c FROM seckill_orders WHERE activity_id = ?')
    .get(activity.id).c;
  assert.equal(count, 1);
  assert.equal(
    db.prepare('SELECT sold FROM seckill_activities WHERE id = ?').get(activity.id).sold,
    1
  );
});

test('并发抢购不会超卖', async (t) => {
  const { server, base, db } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyers = await Promise.all(
    Array.from({ length: 6 }, (_, i) => login(base, `并发买家${i}`))
  );
  const { activity } = await setupSeckill(base, leader.token, {
    activity: { stock: 3, limit_per_user: 1 },
  });

  const results = await Promise.all(
    buyers.map((buyer) => seckillOrder(base, buyer.token, activity.id))
  );
  const created = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 400 && r.body.code === 'SOLD_OUT');
  assert.equal(created.length, 3);
  assert.equal(rejected.length, 3);
  assert.equal(
    db.prepare('SELECT sold FROM seckill_activities WHERE id = ?').get(activity.id).sold,
    3
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS c FROM seckill_orders WHERE activity_id = ?`).get(activity.id).c,
    3
  );
});

test('支付超时自动取消并释放库存，可再次抢购', async (t) => {
  const { server, base, db } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const other = await login(base, '另一个买家');
  const { activity } = await setupSeckill(base, leader.token, {
    activity: { stock: 1, limit_per_user: 1, pay_timeout_minutes: 1 },
  });

  const order = await seckillOrder(base, buyer.token, activity.id);
  assert.equal(order.status, 201);
  assert.equal(
    db.prepare('SELECT sold FROM seckill_activities WHERE id = ?').get(activity.id).sold,
    1
  );

  // 把支付期限拨到过去，读取订单列表触发惰性取消
  db.prepare('UPDATE seckill_orders SET expires_at = ? WHERE id = ?').run(
    new Date(Date.now() - 1000).toISOString(),
    order.body.id
  );
  const list = await api(base, { path: '/api/seckill/orders', token: buyer.token });
  assert.equal(list.status, 200);
  assert.equal(list.body[0].status, 'cancelled');
  assert.equal(
    db.prepare('SELECT sold FROM seckill_activities WHERE id = ?').get(activity.id).sold,
    0
  );

  const retry = await seckillOrder(base, other.token, activity.id);
  assert.equal(retry.status, 201);

  const stats = await adminApi(base, {
    path: `/api/admin/seckill/activities/${activity.id}/stats`,
  });
  assert.equal(stats.body.events.order_timeout_cancelled, 1);
});

test('支付幂等：重复支付与重复回调都不重复记账', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { activity } = await setupSeckill(base, leader.token);

  const order = await seckillOrder(base, buyer.token, activity.id);
  const pay1 = await api(base, {
    method: 'POST',
    path: `/api/seckill/orders/${order.body.id}/pay`,
    token: buyer.token,
  });
  assert.equal(pay1.status, 200);
  assert.equal(pay1.body.status, 'paid');
  const paidAt = pay1.body.paid_at;

  const pay2 = await api(base, {
    method: 'POST',
    path: `/api/seckill/orders/${order.body.id}/pay`,
    token: buyer.token,
  });
  assert.equal(pay2.status, 200);
  assert.equal(pay2.body.already_paid, true);
  assert.equal(pay2.body.paid_at, paidAt);

  const notify = await api(base, {
    method: 'POST',
    path: '/api/payments/notify',
    body: { order_no: order.body.order_no, status: 'paid' },
  });
  assert.equal(notify.status, 200);
  assert.equal(notify.body.code, 'SUCCESS');

  const stats = await adminApi(base, {
    path: `/api/admin/seckill/activities/${activity.id}/stats`,
  });
  assert.equal(stats.body.metrics.paid_count, 1);
  assert.equal(stats.body.metrics.paid_amount, 1990);
  assert.equal(stats.body.events.payment_notify_duplicate, 1);
});

test('取消后收到支付成功回调：自动退款并记录异常', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { activity } = await setupSeckill(base, leader.token);

  const order = await seckillOrder(base, buyer.token, activity.id);
  await api(base, {
    method: 'POST',
    path: `/api/seckill/orders/${order.body.id}/cancel`,
    token: buyer.token,
  });

  const notify = await api(base, {
    method: 'POST',
    path: '/api/payments/notify',
    body: { order_no: order.body.order_no, status: 'paid' },
  });
  assert.equal(notify.status, 200);

  const detail = await api(base, {
    path: `/api/seckill/orders/${order.body.id}`,
    token: buyer.token,
  });
  assert.equal(detail.body.status, 'refunded');

  const stats = await adminApi(base, {
    path: `/api/admin/seckill/activities/${activity.id}/stats`,
  });
  assert.equal(stats.body.events.payment_after_cancel_refunded, 1);
  assert.equal(stats.body.metrics.refunded_count, 1);
  assert.equal(stats.body.metrics.remaining_stock, 5);

  const logs = await adminApi(base, {
    path: `/api/admin/seckill/activities/${activity.id}/logs`,
  });
  assert.ok(logs.body.some((log) => log.action === 'refund_after_cancel'));
});

test('运营配置校验：非法价格/库存/时间/限购/支付期限不能创建或发布', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const productRes = await api(base, {
    method: 'POST',
    path: '/api/products',
    token: leader.token,
    body: { title: '秒杀校验商品', price: 5000, stock: 100 },
  });
  const product = productRes.body;

  const invalidCases = [
    [{ seckill_price: 5000 }, 'INVALID_PRICE'],
    [{ seckill_price: 0 }, 'INVALID_PRICE'],
    [{ stock: 0 }, 'INVALID_STOCK'],
    [{ limit_per_user: 0 }, 'INVALID_LIMIT'],
    [{ pay_timeout_minutes: 0 }, 'INVALID_PAY_TIMEOUT'],
    [{ pay_timeout_minutes: 121 }, 'INVALID_PAY_TIMEOUT'],
    [{ start_at: inFuture(120), end_at: inFuture(60) }, 'INVALID_TIME'],
    [{ start_at: 'not-a-date' }, 'INVALID_TIME'],
  ];
  for (const [overrides, code] of invalidCases) {
    const res = await createDraft(base, product.id, overrides);
    assert.equal(res.status, 400, JSON.stringify(overrides));
    assert.equal(res.body.code, code, JSON.stringify(overrides));
  }

  const missingProduct = await createDraft(base, 999999);
  assert.equal(missingProduct.status, 400);
  assert.equal(missingProduct.body.code, 'PRODUCT_NOT_FOUND');

  // 草稿配置合法但结束时间已过：发布被拒
  const draft = await createDraft(base, product.id, {
    start_at: new Date(Date.now() - 7200_000).toISOString(),
    end_at: inFuture(60),
  });
  assert.equal(draft.status, 201);
  await adminApi(base, {
    method: 'PUT',
    path: `/api/admin/seckill/activities/${draft.body.id}`,
    body: { end_at: new Date(Date.now() - 60_000).toISOString() },
  });
  const publish = await adminApi(base, {
    method: 'POST',
    path: `/api/admin/seckill/activities/${draft.body.id}/publish`,
  });
  assert.equal(publish.status, 400);
  assert.equal(publish.body.code, 'INVALID_TIME');

  // 库存不能调到已售数量以下
  const { activity } = await setupSeckill(base, leader.token);
  const sell = await seckillOrder(base, leader.token, activity.id);
  assert.equal(sell.status, 201);
  const shrink = await adminApi(base, {
    method: 'PUT',
    path: `/api/admin/seckill/activities/${activity.id}`,
    body: { stock: 0 },
  });
  assert.equal(shrink.status, 400);
  assert.equal(shrink.body.code, 'INVALID_STOCK');
});

test('提前终止后停止新下单，关键操作留有日志与数据', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { activity } = await setupSeckill(base, leader.token);

  const detail = await api(base, {
    path: `/api/seckill/activities/${activity.id}`,
    token: buyer.token,
  });
  assert.equal(detail.body.status, 'ongoing');

  const order = await seckillOrder(base, buyer.token, activity.id);
  assert.equal(order.status, 201);

  const terminate = await adminApi(base, {
    method: 'POST',
    path: `/api/admin/seckill/activities/${activity.id}/terminate`,
    body: { reason: '库存异常，提前结束' },
  });
  assert.equal(terminate.status, 200);
  assert.equal(terminate.body.status, 'terminated');

  const blocked = await seckillOrder(base, buyer.token, activity.id, { request_id: 'after-terminate' });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.code, 'NOT_PURCHASABLE');

  const stats = await adminApi(base, {
    path: `/api/admin/seckill/activities/${activity.id}/stats`,
  });
  assert.equal(stats.body.metrics.order_count, 1);
  assert.equal(stats.body.metrics.activity_views, 1);
  assert.equal(stats.body.metrics.order_conversion, 1);

  const logs = await adminApi(base, {
    path: `/api/admin/seckill/activities/${activity.id}/logs`,
  });
  const actions = logs.body.map((log) => log.action);
  for (const action of ['create', 'publish', 'terminate']) {
    assert.ok(actions.includes(action), `missing log action ${action}`);
  }
  const terminateLog = logs.body.find((log) => log.action === 'terminate');
  assert.equal(terminateLog.detail.reason, '库存异常，提前结束');
});

test('履约信息与参数校验：地址、自提点、数量、幂等键必填', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { activity } = await setupSeckill(base, leader.token);

  const noAddress = await api(base, {
    method: 'POST',
    path: `/api/seckill/activities/${activity.id}/orders`,
    token: buyer.token,
    body: { quantity: 1, request_id: 'no-address', delivery_method: 'express' },
  });
  assert.equal(noAddress.status, 400);
  assert.equal(noAddress.body.code, 'ADDRESS_REQUIRED');

  const noRequestId = await api(base, {
    method: 'POST',
    path: `/api/seckill/activities/${activity.id}/orders`,
    token: buyer.token,
    body: { quantity: 1, delivery_method: 'express', address: { detail: 'x' } },
  });
  assert.equal(noRequestId.status, 400);
  assert.equal(noRequestId.body.code, 'INVALID_REQUEST_ID');

  const badQuantity = await seckillOrder(base, buyer.token, activity.id, { quantity: 0 });
  assert.equal(badQuantity.status, 400);
  assert.equal(badQuantity.body.code, 'INVALID_QUANTITY');

  const noPoint = await seckillOrder(base, buyer.token, activity.id, {
    delivery_method: 'pickup',
    address: null,
  });
  assert.equal(noPoint.status, 400);
  assert.equal(noPoint.body.code, 'PICKUP_POINT_REQUIRED');

  const pointRes = await api(base, {
    method: 'POST',
    path: '/api/pickup-points',
    token: leader.token,
    body: { name: '小区自提点', address: '1 号楼' },
  });
  assert.equal(pointRes.status, 201);
  const pickup = await seckillOrder(base, buyer.token, activity.id, {
    delivery_method: 'pickup',
    address: null,
    pickup_point_id: pointRes.body.id,
  });
  assert.equal(pickup.status, 201);
  assert.equal(pickup.body.delivery_method, 'pickup');

  const otherBuyer = await login(base, '另一个买家');
  const forbidden = await api(base, {
    path: `/api/seckill/orders/${pickup.body.id}`,
    token: otherBuyer.token,
  });
  assert.equal(forbidden.status, 403);
});

test('秒杀接口需要用户登录，运营接口需要 admin token', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const anonymous = await api(base, { path: '/api/seckill/activities' });
  assert.equal(anonymous.status, 401);

  const noAdmin = await api(base, { path: '/api/admin/seckill/activities' });
  assert.equal(noAdmin.status, 401);

  const leader = await login(base, '团长');
  const { activity } = await setupSeckill(base, leader.token);
  const list = await api(base, { path: '/api/seckill/activities', token: leader.token });
  assert.equal(list.status, 200);
  assert.ok(list.body.some((item) => item.id === activity.id));
  assert.ok(list.body[0].product);
});
