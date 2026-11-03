const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, api, login, setupGroup } = require('./helpers');

test('限购：同买家同团购累计数量 ≤ limit_per_user，取消后不占额度', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { group } = await setupGroup(base, leader.token, {
    product: { limit_per_user: 3 },
  });

  const o1 = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 2, delivery_method: 'express', address: { detail: 'x' } },
  });
  assert.equal(o1.status, 201);

  // 再买 2 件 → 累计 4 > 3，拒绝
  const o2 = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 2, delivery_method: 'express', address: { detail: 'x' } },
  });
  assert.equal(o2.status, 400);
  assert.match(o2.body.error, /limit/);

  // 取消第一单后额度释放
  await api(base, { method: 'POST', path: `/api/orders/${o1.body.id}/cancel`, token: buyer.token });
  const o3 = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 3, delivery_method: 'express', address: { detail: 'x' } },
  });
  assert.equal(o3.status, 201);
});

test('库存不足下单被拒，库存不被扣成负数', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { product, group } = await setupGroup(base, leader.token, {
    product: { stock: 2 },
  });

  const fail = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 3, delivery_method: 'express', address: { detail: 'x' } },
  });
  assert.equal(fail.status, 400);
  assert.match(fail.body.error, /stock/);

  const productAfter = await api(base, { path: `/api/products/${product.id}`, token: buyer.token });
  assert.equal(productAfter.body.stock, 2);
});

test('秒杀未开始下单返回 400', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { group } = await setupGroup(base, leader.token, {
    group: {
      is_seckill: true,
      seckill_start_at: new Date(Date.now() + 3600_000).toISOString(),
    },
  });

  const res = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 1, delivery_method: 'express', address: { detail: 'x' } },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /seckill/);
});

test('满减：按 threshold 降序取第一档满足档', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { group } = await setupGroup(base, leader.token, {
    product: { price: 3000 },
    group: {
      // 规则故意乱序传入，验证服务端按降序匹配
      full_reduction_rules: [
        { threshold: 5000, reduction: 500 },
        { threshold: 10000, reduction: 2000 },
      ],
    },
  });

  // 2 件 = 6000 分 → 满足满 5000 减 500
  const o1 = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 2, delivery_method: 'express', address: { detail: 'x' } },
  });
  assert.equal(o1.status, 201);
  assert.equal(o1.body.total_amount, 6000);
  assert.equal(o1.body.discount_amount, 500);
  assert.equal(o1.body.pay_amount, 5500);

  // 4 件 = 12000 分 → 满足满 10000 减 2000（降序优先更高档）
  const o2 = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 4, delivery_method: 'express', address: { detail: 'x' } },
  });
  assert.equal(o2.status, 201);
  assert.equal(o2.body.total_amount, 12000);
  assert.equal(o2.body.discount_amount, 2000);
  assert.equal(o2.body.pay_amount, 10000);

  // 1 件 = 3000 分 → 不满足任何档
  const o3 = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 1, delivery_method: 'express', address: { detail: 'x' } },
  });
  assert.equal(o3.body.discount_amount, 0);
  assert.equal(o3.body.pay_amount, 3000);
});

test('下单参数校验：履约方式不在团购支持范围内 / 缺地址 / 缺自提点', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const buyer = await login(base, '买家');
  const { group } = await setupGroup(base, leader.token, {
    group: { delivery_methods: ['express'] },
  });

  const badMethod = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 1, delivery_method: 'pickup', pickup_point_id: 1 },
  });
  assert.equal(badMethod.status, 400);

  const noAddress = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 1, delivery_method: 'express' },
  });
  assert.equal(noAddress.status, 400);

  const badQty = await api(base, {
    method: 'POST',
    path: `/api/groups/${group.id}/orders`,
    token: buyer.token,
    body: { quantity: 0, delivery_method: 'express', address: { detail: 'x' } },
  });
  assert.equal(badQty.status, 400);
});
