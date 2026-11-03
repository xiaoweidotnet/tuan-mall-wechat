const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, api, login, setupGroup } = require('./helpers');

test('团长编辑 active 团购：改 end_at/target_quantity/full_reduction_rules 生效', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const { group } = await setupGroup(base, leader.token);

  const newEndAt = new Date(Date.now() + 7200_000).toISOString();
  const res = await api(base, {
    method: 'PUT',
    path: `/api/groups/${group.id}`,
    token: leader.token,
    body: {
      end_at: newEndAt,
      target_quantity: 10,
      full_reduction_rules: [{ threshold: 5000, reduction: 500 }],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.end_at, newEndAt);
  assert.equal(res.body.target_quantity, 10);
  assert.deepEqual(res.body.full_reduction_rules, [{ threshold: 5000, reduction: 500 }]);
  // 未传字段保持原值
  assert.equal(res.body.title, group.title);
  assert.deepEqual(res.body.delivery_methods, ['express', 'pickup']);
  assert.equal(res.body.product_id, group.product_id);
  assert.equal(res.body.status, 'active');
});

test('编辑团购：非团长 403，非 active 团购 400，非法 delivery_methods 400', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const other = await login(base, '路人');
  const { group } = await setupGroup(base, leader.token);

  // 非团长编辑 → 403
  const forbidden = await api(base, {
    method: 'PUT',
    path: `/api/groups/${group.id}`,
    token: other.token,
    body: { title: '改名' },
  });
  assert.equal(forbidden.status, 403);

  // 非法 delivery_methods → 400
  const emptyMethods = await api(base, {
    method: 'PUT',
    path: `/api/groups/${group.id}`,
    token: leader.token,
    body: { delivery_methods: [] },
  });
  assert.equal(emptyMethods.status, 400);
  assert.match(emptyMethods.body.error, /delivery_methods/);

  const badMethods = await api(base, {
    method: 'PUT',
    path: `/api/groups/${group.id}`,
    token: leader.token,
    body: { delivery_methods: ['express', 'drone'] },
  });
  assert.equal(badMethods.status, 400);
  assert.match(badMethods.body.error, /delivery_methods/);

  // 截团后（succeeded）再编辑 → 400
  await api(base, { method: 'POST', path: `/api/groups/${group.id}/close`, token: leader.token });
  const closed = await api(base, {
    method: 'PUT',
    path: `/api/groups/${group.id}`,
    token: leader.token,
    body: { title: '改名' },
  });
  assert.equal(closed.status, 400);
  assert.match(closed.body.error, /succeeded/);
});

test('下架商品不可开团：product status=off 时 POST /api/groups 返回 400', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const leader = await login(base, '团长');
  const productRes = await api(base, {
    method: 'POST',
    path: '/api/products',
    token: leader.token,
    body: { title: '下架商品', price: 1000, stock: 10, status: 'off' },
  });
  assert.equal(productRes.status, 201);

  const groupRes = await api(base, {
    method: 'POST',
    path: '/api/groups',
    token: leader.token,
    body: {
      product_id: productRes.body.id,
      end_at: new Date(Date.now() + 3600_000).toISOString(),
    },
  });
  assert.equal(groupRes.status, 400);
  assert.match(groupRes.body.error, /off/);
});
