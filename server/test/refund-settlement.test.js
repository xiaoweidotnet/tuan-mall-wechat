const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, api, login, setupGroup } = require('./helpers');

test('退款流程：申请退款→团长审批→refunded 且库存回补', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { product, group } = await setupGroup(base, leader.token);

  const orderRes = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 3, delivery_method: 'express', address: { detail: 'x' } },
  });
  const order = orderRes.body;
  await api(base, { method: 'POST', path: `/api/orders/${order.id}/pay`, token: buyer.token });

  // 申请退款
  const refund = await api(base, { method: 'POST', path: `/api/orders/${order.id}/refund`, token: buyer.token });
  assert.equal(refund.status, 200);
  assert.equal(refund.body.status, 'refund_requested');

  // 买家无权审批自己的退款
  const buyerApprove = await api(base, {
    method: 'POST',
    path: `/api/orders/${order.id}/refund/approve`,
    token: buyer.token,
  });
  assert.equal(buyerApprove.status, 403);

  // 团长审批 → refunded，库存回补
  const approve = await api(base, {
    method: 'POST',
    path: `/api/orders/${order.id}/refund/approve`,
    token: leader.token,
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.status, 'refunded');

  const productAfter = await api(base, { path: `/api/products/${product.id}`, token: buyer.token });
  assert.equal(productAfter.body.stock, 100);

  // refunded 不计入已售
  const detail = await api(base, { path: `/api/groups/${group.id}`, token: buyer.token });
  assert.equal(detail.body.sold_quantity, 0);
});

test('未支付取消订单回补库存', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { product, group } = await setupGroup(base, leader.token, { product: { stock: 5 } });

  const orderRes = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 5, delivery_method: 'express', address: { detail: 'x' } },
  });
  assert.equal(orderRes.status, 201);

  let productNow = await api(base, { path: `/api/products/${product.id}`, token: buyer.token });
  assert.equal(productNow.body.stock, 0);

  const cancel = await api(base, {
    method: 'POST',
    path: `/api/orders/${orderRes.body.id}/cancel`,
    token: buyer.token,
  });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.status, 'cancelled');

  productNow = await api(base, { path: `/api/products/${product.id}`, token: buyer.token });
  assert.equal(productNow.body.stock, 5);

  // 已支付订单不能取消
  const order2 = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 1, delivery_method: 'express', address: { detail: 'x' } },
  });
  await api(base, { method: 'POST', path: `/api/orders/${order2.body.id}/pay`, token: buyer.token });
  const cancelPaid = await api(base, {
    method: 'POST',
    path: `/api/orders/${order2.body.id}/cancel`,
    token: buyer.token,
  });
  assert.equal(cancelPaid.status, 400);
});

test('未成团自动退款：target 未达标且到期 → 团购 failed、订单自动 refunded、库存回补', async (t) => {
  const { server, base, db } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { product, group } = await setupGroup(base, leader.token, {
    group: { target_quantity: 10 },
  });

  const orderRes = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 2, delivery_method: 'express', address: { detail: 'x' } },
  });
  await api(base, { method: 'POST', path: `/api/orders/${orderRes.body.id}/pay`, token: buyer.token });

  // 把时间拨到 end_at 之后，模拟到期
  db.prepare('UPDATE groups SET end_at = ? WHERE id = ?').run(
    new Date(Date.now() - 1000).toISOString(),
    group.id
  );

  // 读路径触发惰性结算
  const detail = await api(base, { path: `/api/groups/${group.id}`, token: buyer.token });
  assert.equal(detail.body.status, 'failed');
  assert.equal(detail.body.sold_quantity, 0);

  const order = await api(base, { path: `/api/orders/${orderRes.body.id}`, token: buyer.token });
  assert.equal(order.body.status, 'refunded');

  const productAfter = await api(base, { path: `/api/products/${product.id}`, token: buyer.token });
  assert.equal(productAfter.body.stock, 100);

  // failed 团购不能再下单
  const late = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 1, delivery_method: 'express', address: { detail: 'x' } },
  });
  assert.equal(late.status, 400);
});

test('达标到期 → succeeded；团长手动截团走同样结算逻辑', async (t) => {
  const { server, base, db } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');

  // 达标团：target=2，买 2 件
  const { group: okGroup } = await setupGroup(base, leader.token, {
    group: { target_quantity: 2 },
  });
  const orderRes = await api(base, {
    method: 'POST',
    path: `/api/groups/${okGroup.id}/orders`,
    token: buyer.token,
    body: { quantity: 2, delivery_method: 'express', address: { detail: 'x' } },
  });
  await api(base, { method: 'POST', path: `/api/orders/${orderRes.body.id}/pay`, token: buyer.token });
  db.prepare('UPDATE groups SET end_at = ? WHERE id = ?').run(
    new Date(Date.now() - 1000).toISOString(),
    okGroup.id
  );
  const okDetail = await api(base, { path: `/api/groups/${okGroup.id}`, token: buyer.token });
  assert.equal(okDetail.body.status, 'succeeded');
  const okOrder = await api(base, { path: `/api/orders/${orderRes.body.id}`, token: buyer.token });
  assert.equal(okOrder.body.status, 'paid'); // 达标不退款

  // 手动截团：未到期、未达标 → failed + 自动退款
  const { group: closeGroup } = await setupGroup(base, leader.token, {
    group: { target_quantity: 5 },
  });
  const order2 = await api(base, {
    method: 'POST',
    path: `/api/groups/${closeGroup.id}/orders`,
    token: buyer.token,
    body: { quantity: 1, delivery_method: 'express', address: { detail: 'x' } },
  });
  await api(base, { method: 'POST', path: `/api/orders/${order2.body.id}/pay`, token: buyer.token });

  // 非团长不能截团
  const forbidden = await api(base, {
    method: 'POST',
    path: `/api/groups/${closeGroup.id}/close`,
    token: buyer.token,
  });
  assert.equal(forbidden.status, 403);

  const closed = await api(base, {
    method: 'POST',
    path: `/api/groups/${closeGroup.id}/close`,
    token: leader.token,
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, 'failed');
  const order2After = await api(base, { path: `/api/orders/${order2.body.id}`, token: buyer.token });
  assert.equal(order2After.body.status, 'refunded');
});
