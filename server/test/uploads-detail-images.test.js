const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, api, login } = require('./helpers');

test('上传图片成功返回 url，且可通过该 url 取回内容', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const { token } = await login(base, '团长');
  const content = Buffer.from('fake-png-bytes-12345');
  const res = await api(base, {
    method: 'POST',
    path: '/api/uploads',
    token,
    body: { data: content.toString('base64'), ext: 'png' },
  });
  assert.equal(res.status, 201);
  assert.match(res.body.url, /^\/uploads\/[0-9a-f]{32}\.png$/);

  const fileRes = await fetch(`${base}${res.body.url}`);
  assert.equal(fileRes.status, 200);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  assert.deepEqual(buf, content);
});

test('上传：非法 ext 返回 400', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const { token } = await login(base, '团长');
  const res = await api(base, {
    method: 'POST',
    path: '/api/uploads',
    token,
    body: { data: Buffer.from('x').toString('base64'), ext: 'exe' },
  });
  assert.equal(res.status, 400);
});

test('上传：缺 data 返回 400', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const { token } = await login(base, '团长');
  const res = await api(base, {
    method: 'POST',
    path: '/api/uploads',
    token,
    body: { ext: 'png' },
  });
  assert.equal(res.status, 400);
});

test('上传：未鉴权返回 401', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const res = await api(base, {
    method: 'POST',
    path: '/api/uploads',
    body: { data: Buffer.from('x').toString('base64'), ext: 'png' },
  });
  assert.equal(res.status, 401);
});

test('上传：解码后超过 5MB 返回 413', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const { token } = await login(base, '团长');
  const big = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
  const res = await api(base, {
    method: 'POST',
    path: '/api/uploads',
    token,
    body: { data: big.toString('base64'), ext: 'jpg' },
  });
  assert.equal(res.status, 413);
});

test('商品 POST/PUT 带 detail_images 往返正确', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const { token } = await login(base, '团长');

  // 创建时带 detail_images
  const created = await api(base, {
    method: 'POST',
    path: '/api/products',
    token,
    body: {
      title: '测试商品',
      price: 1000,
      stock: 10,
      images: ['/uploads/a.png'],
      detail_images: ['/uploads/d1.png', '/uploads/d2.png'],
    },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.detail_images, ['/uploads/d1.png', '/uploads/d2.png']);
  const productId = created.body.id;

  // GET 详情返回数组
  const detail = await api(base, { path: `/api/products/${productId}`, token });
  assert.deepEqual(detail.body.detail_images, ['/uploads/d1.png', '/uploads/d2.png']);

  // PUT 更新 detail_images
  const updated = await api(base, {
    method: 'PUT',
    path: `/api/products/${productId}`,
    token,
    body: { detail_images: ['/uploads/d3.png'] },
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.detail_images, ['/uploads/d3.png']);

  // PUT 不带 detail_images 保持原值
  const kept = await api(base, {
    method: 'PUT',
    path: `/api/products/${productId}`,
    token,
    body: { title: '改名商品' },
  });
  assert.equal(kept.status, 200);
  assert.deepEqual(kept.body.detail_images, ['/uploads/d3.png']);

  // 缺省创建时 detail_images 为 []
  const plain = await api(base, {
    method: 'POST',
    path: '/api/products',
    token,
    body: { title: '无图商品', price: 100, stock: 1 },
  });
  assert.equal(plain.status, 201);
  assert.deepEqual(plain.body.detail_images, []);
});

test('商品 POST/PUT：detail_images 非数组返回 400', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const { token } = await login(base, '团长');

  const badCreate = await api(base, {
    method: 'POST',
    path: '/api/products',
    token,
    body: { title: '坏商品', price: 100, stock: 1, detail_images: 'not-an-array' },
  });
  assert.equal(badCreate.status, 400);

  const badElements = await api(base, {
    method: 'POST',
    path: '/api/products',
    token,
    body: { title: '坏商品', price: 100, stock: 1, detail_images: [1, 2] },
  });
  assert.equal(badElements.status, 400);

  const created = await api(base, {
    method: 'POST',
    path: '/api/products',
    token,
    body: { title: '正常商品', price: 100, stock: 1 },
  });
  const badUpdate = await api(base, {
    method: 'PUT',
    path: `/api/products/${created.body.id}`,
    token,
    body: { detail_images: { url: '/uploads/x.png' } },
  });
  assert.equal(badUpdate.status, 400);
});
