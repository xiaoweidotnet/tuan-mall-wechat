const { createApp } = require('../src/app');

// 每个用例起独立 app + :memory: 数据库 + 随机端口；options 可注入依赖（如 wechat 替身）
function startServer(options = {}) {
  const app = createApp({ dbPath: ':memory:', ...options });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        app,
        db: app.locals.db,
        server,
        base: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

async function api(base, { method = 'GET', path, token, body }) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function login(base, nickname) {
  const res = await api(base, { method: 'POST', path: '/api/auth/mock-login', body: { nickname } });
  if (res.status !== 201) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
  return res.body; // { token, user }
}

// 常用脚手架：团长登录 + 发商品 + 开团
async function setupGroup(base, leaderToken, overrides = {}) {
  const productRes = await api(base, {
    method: 'POST',
    path: '/api/products',
    token: leaderToken,
    body: {
      title: '烟台红富士苹果 5 斤装',
      price: 3000,
      original_price: 4500,
      stock: 100,
      limit_per_user: 0,
      ...(overrides.product || {}),
    },
  });
  if (productRes.status !== 201) throw new Error(`create product failed: ${JSON.stringify(productRes.body)}`);
  const product = productRes.body;

  const endAt = overrides.endAt || new Date(Date.now() + 3600_000).toISOString();
  const groupRes = await api(base, {
    method: 'POST',
    path: '/api/groups',
    token: leaderToken,
    body: {
      product_id: product.id,
      end_at: endAt,
      target_quantity: 0,
      delivery_methods: ['express', 'pickup'],
      ...(overrides.group || {}),
    },
  });
  if (groupRes.status !== 201) throw new Error(`create group failed: ${JSON.stringify(groupRes.body)}`);
  return { product, group: groupRes.body };
}

module.exports = { startServer, api, login, setupGroup };
