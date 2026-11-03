const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, api, login, setupGroup } = require('./helpers');

test('端到端主流程：登录→发商品→开团→下单→支付→快递发货→确认收货→完成', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  // 登录（团长 + 买家）
  const leader = await login(base, '团长小王');
  const buyer = await login(base, '买家小李');
  assert.ok(leader.token);
  assert.equal(leader.user.nickname, '团长小王');

  // 未鉴权请求被拒
  const noAuth = await api(base, { path: '/api/products' });
  assert.equal(noAuth.status, 401);

  // 发商品 + 开团
  const { product, group } = await setupGroup(base, leader.token);
  assert.equal(product.price, 3000);
  assert.equal(group.status, 'active');

  // 团购列表/详情（详情含已售数量）
  const list = await api(base, { path: '/api/groups', token: buyer.token });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.deepEqual(list.body[0].product.images, product.images);
  assert.deepEqual(list.body[0].product.detail_images, product.detail_images);
  const detailBefore = await api(base, { path: `/api/groups/${group.id}`, token: buyer.token });
  assert.equal(detailBefore.body.sold_quantity, 0);
  assert.equal(detailBefore.body.product.id, product.id);

  // 下单（快递）
  const orderRes = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: {
      quantity: 2,
      delivery_method: 'express',
      address: { name: '小李', phone: '13800000000', detail: '上海市徐汇区 xx 路 1 号' },
    },
  });
  assert.equal(orderRes.status, 201);
  const order = orderRes.body;
  assert.equal(order.status, 'pending');
  assert.equal(order.total_amount, 6000);
  assert.equal(order.discount_amount, 0);
  assert.equal(order.pay_amount, 6000);
  assert.ok(order.order_no);

  // 下单即扣库存
  const productAfter = await api(base, { path: `/api/products/${product.id}`, token: buyer.token });
  assert.equal(productAfter.body.stock, 98);

  // 已售数量更新
  const detailAfter = await api(base, { path: `/api/groups/${group.id}`, token: buyer.token });
  assert.equal(detailAfter.body.sold_quantity, 2);

  // 我的订单（买家视角）
  const myOrders = await api(base, { path: '/api/orders?role=buyer', token: buyer.token });
  assert.equal(myOrders.body.length, 1);
  assert.equal(myOrders.body[0].id, order.id);

  // 支付
  const pay = await api(base, { method: 'POST', path: `/api/orders/${order.id}/pay`, token: buyer.token });
  assert.equal(pay.status, 200);
  assert.equal(pay.body.status, 'paid');
  assert.ok(pay.body.paid_at);

  // 团长视角能看到订单
  const leaderOrders = await api(base, { path: '/api/orders?role=leader', token: leader.token });
  assert.equal(leaderOrders.body.length, 1);

  // 团长发货 → 买家确认收货 → completed
  const ship = await api(base, {
    method: 'POST',
    path: `/api/orders/${order.id}/ship`,
    token: leader.token,
    body: { tracking_no: 'SF1234567890' },
  });
  assert.equal(ship.status, 200);
  assert.equal(ship.body.status, 'shipped');

  const receipt = await api(base, {
    method: 'POST',
    path: `/api/orders/${order.id}/confirm-receipt`,
    token: buyer.token,
  });
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.status, 'completed');
});

test('端到端自提流程：下单→支付→团长核销→完成', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');

  // 自提点
  const pointRes = await api(base, {
    method: 'POST',
    path: '/api/pickup-points',
    token: leader.token,
    body: { name: '小区门口便利店', address: '幸福路 12 号', contact: '店长 13911112222' },
  });
  assert.equal(pointRes.status, 201);
  const point = pointRes.body;

  const points = await api(base, { path: '/api/pickup-points', token: buyer.token });
  assert.equal(points.body.length, 1);

  const { group } = await setupGroup(base, leader.token);

  const orderRes = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 1, delivery_method: 'pickup', pickup_point_id: point.id },
  });
  assert.equal(orderRes.status, 201);
  const order = orderRes.body;

  await api(base, { method: 'POST', path: `/api/orders/${order.id}/pay`, token: buyer.token });

  // 快递发货对自提单无效
  const shipFail = await api(base, {
    method: 'POST',
    path: `/api/orders/${order.id}/ship`,
    token: leader.token,
    body: { tracking_no: 'X1' },
  });
  assert.equal(shipFail.status, 400);

  // 买家无权核销
  const buyerConfirm = await api(base, {
    method: 'POST',
    path: `/api/orders/${order.id}/confirm-pickup`,
    token: buyer.token,
  });
  assert.equal(buyerConfirm.status, 403);

  // 团长核销 → completed
  const confirm = await api(base, {
    method: 'POST',
    path: `/api/orders/${order.id}/confirm-pickup`,
    token: leader.token,
  });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.status, 'completed');
});
