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

// 运营后台接口：使用配置里的固定 admin token
async function adminApi(base, { method = 'GET', path, body }) {
  const config = require('../src/config');
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-admin-token': config.admin.token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// 秒杀脚手架：团长发商品 + 运营创建/发布活动
async function setupSeckill(base, leaderToken, overrides = {}) {
  const productRes = await api(base, {
    method: 'POST',
    path: '/api/products',
    token: leaderToken,
    body: {
      title: '秒杀商品 · 云南蓝莓 2 盒',
      price: 5000,
      original_price: 8000,
      stock: 50,
      limit_per_user: 0,
      ...(overrides.product || {}),
    },
  });
  if (productRes.status !== 201) {
    throw new Error(`create product failed: ${JSON.stringify(productRes.body)}`);
  }
  const product = productRes.body;

  const startAt = overrides.startAt || new Date(Date.now() - 60_000).toISOString();
  const endAt = overrides.endAt || new Date(Date.now() + 3600_000).toISOString();
  const createRes = await adminApi(base, {
    method: 'POST',
    path: '/api/admin/seckill/activities',
    body: {
      product_id: product.id,
      seckill_price: 1990,
      stock: 5,
      start_at: startAt,
      end_at: endAt,
      limit_per_user: 1,
      ...(overrides.activity || {}),
    },
  });
  if (createRes.status !== 201) {
    throw new Error(`create activity failed: ${JSON.stringify(createRes.body)}`);
  }
  let activity = createRes.body;
  if (overrides.publish !== false) {
    const publishRes = await adminApi(base, {
      method: 'POST',
      path: `/api/admin/seckill/activities/${activity.id}/publish`,
    });
    if (publishRes.status !== 200) {
      throw new Error(`publish activity failed: ${JSON.stringify(publishRes.body)}`);
    }
    activity = publishRes.body;
  }
  return { product, activity };
}

// 抢购下单
function seckillOrder(base, token, activityId, body = {}) {
  return api(base, {
    method: 'POST',
    path: `/api/seckill/activities/${activityId}/orders`,
    token,
    body: {
      quantity: 1,
      request_id: `req_${Math.random().toString(36).slice(2)}`,
      delivery_method: 'express',
      address: { name: '张三', phone: '13800000000', detail: '北京市朝阳区 1 号' },
      ...body,
    },
  });
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

module.exports = { startServer, api, login, setupGroup, adminApi, setupSeckill, seckillOrder };
