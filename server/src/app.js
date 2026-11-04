const express = require('express');
const crypto = require('crypto');
const { createDb, now } = require('./db');
const { issueToken, createAuthMiddleware } = require('./auth');
const config = require('./config');
const wechatService = require('./services/wechat');
const { createSmsService } = require('./services/sms');
const { createPhoneAuthRouter } = require('./routes/phoneAuth');
const productsRouter = require('./routes/products');
const groupsRouter = require('./routes/groups');
const { ordersRouter, createOrderHandler } = require('./routes/orders');
const pickupPointsRouter = require('./routes/pickupPoints');
const uploadsRouter = require('./routes/uploads');
const { UPLOAD_DIR } = uploadsRouter;

const NICKNAME_MAX_LEN = 20;
const AVATAR_URL_MAX_LEN = 500;

/** 资料是否完整：昵称必填（头像允许后续在"我的"里补） */
function isProfileComplete(user) {
  return !!(user && typeof user.nickname === 'string' && user.nickname.trim());
}

function createApp(options = {}) {
  const db = createDb(options.dbPath || ':memory:');
  const tokens = new Map(); // token -> userId
  const wechat = options.wechat || wechatService; // 测试可注入替身
  const sms = createSmsService(
    options.sms ? { provider: options.sms } : { providerName: config.sms.provider }
  ); // 测试可注入验证码发送替身
  const ctx = { db, tokens };

  const app = express();
  app.locals.db = db;
  app.use(express.json({ limit: '10mb' }));

  // 前后端联调：反射 Origin 并允许携带凭证
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] || '*'
    );
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use('/uploads', express.static(UPLOAD_DIR));

  // 调试接口：联调阶段方便查看配置和库内数据
  if (config.debug) {
    app.get('/api/debug/config', (req, res) => {
      res.json({ config, node_env: process.env.NODE_ENV || 'development' });
    });

    app.get('/api/debug/db', (req, res) => {
      res.json({
        users: db.prepare('SELECT * FROM users').all(),
        orders: db.prepare('SELECT * FROM orders').all(),
      });
    });
  }

  // 运营后台：账号密码来自配置，登录后返回固定 admin token
  app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username !== config.admin.username || password !== config.admin.password) {
      return res.status(401).json({ error: 'invalid username or password' });
    }
    res.json({ token: config.admin.token, role: 'admin' });
  });

  app.use('/api/admin', (req, res, next) => {
    if (req.headers['x-admin-token'] !== config.admin.token) {
      return res.status(401).json({ error: 'admin token required' });
    }
    next();
  });

  app.get('/api/admin/users', (req, res) => {
    res.json(db.prepare('SELECT * FROM users ORDER BY id DESC').all());
  });

  app.get('/api/admin/orders', (req, res) => {
    res.json(db.prepare('SELECT * FROM orders ORDER BY id DESC').all());
  });

  // 微信支付回调占位：直接信任请求体里的状态
  app.post('/api/payments/notify', (req, res) => {
    const { order_no, status = 'paid' } = req.body || {};
    if (!order_no) {
      return res.status(400).json({ error: 'order_no is required' });
    }
    const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(order_no);
    if (!order) {
      return res.status(404).json({ error: 'order not found' });
    }
    db.prepare('UPDATE orders SET status = ?, paid_at = ? WHERE id = ?').run(
      status,
      now(),
      order.id
    );
    res.json({ code: 'SUCCESS', message: 'OK' });
  });

  // 团购分享页（服务端渲染，方便微信外打开）
  app.get('/share/group/:id', (req, res) => {
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!group) return res.status(404).send('not found');
    const from = req.query.from || '';
    const next = req.query.next || '/';
    res.type('html').send(`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${group.title}</title></head>
<body>
  <h1>${group.title}</h1>
  <p>${from} 邀请你一起拼团</p>
  <a href="${next}">去看看</a>
</body>
</html>`);
  });

  // 分享链接跳转
  app.get('/redirect', (req, res) => {
    res.redirect(String(req.query.url || '/'));
  });

  // 模拟微信授权登录
  app.post('/api/auth/mock-login', (req, res) => {
    const { nickname } = req.body || {};
    if (!nickname || typeof nickname !== 'string') {
      return res.status(400).json({ error: 'nickname is required' });
    }
    const openid = `mock_${crypto.randomBytes(8).toString('hex')}`;
    const info = db
      .prepare('INSERT INTO users (openid, nickname, avatar_url, created_at) VALUES (?, ?, ?, ?)')
      .run(openid, nickname, '', now());
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    const token = issueToken(tokens, user.id);
    res.status(201).json({ token, user });
  });

  // 微信授权登录：wx.login() 的 code 换 openid，按 openid 找/建用户
  app.post('/api/auth/wechat-login', async (req, res) => {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'code is required' });
    }

    let session;
    try {
      session = await wechat.code2Session(code);
    } catch (err) {
      // 微信侧拒绝（code 无效/复用等）按 400，网络异常按 502
      const status = err.wechatError ? 400 : 502;
      return res.status(status).json({ error: err.message });
    }

    // openid 维度复用账号：已存在直接登录，否则建档（昵称为空 → 资料不完整）
    let user = db.prepare('SELECT * FROM users WHERE openid = ?').get(session.openid);
    if (!user) {
      const info = db
        .prepare('INSERT INTO users (openid, nickname, avatar_url, created_at) VALUES (?, ?, ?, ?)')
        .run(session.openid, '', '', now());
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    }
    const token = issueToken(tokens, user.id);
    res.status(201).json({ token, user, profile_completed: isProfileComplete(user) });
  });

  // 手机号 + 短信验证码登录：发送验证码 / 登录（公开接口）
  app.use(
    '/api/auth',
    createPhoneAuthRouter({
      db,
      tokens,
      sms,
      isProfileComplete,
      limits: options.smsLimits,
    })
  );

  // 其余 /api 接口全部需要鉴权
  app.use('/api', createAuthMiddleware(ctx));

  app.use('/api/products', productsRouter(ctx));
  app.use('/api/groups', groupsRouter(ctx));
  app.post('/api/groups/:id/orders', createOrderHandler(ctx));
  app.use('/api/orders', ordersRouter(ctx));
  app.use('/api/pickup-points', pickupPointsRouter(ctx));
  app.use('/api/uploads', uploadsRouter());

  // 供应商图片导入：服务端拉取远程图片后转成 base64
  app.post('/api/utils/fetch-image', async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }
    try {
      const upstream = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const buffer = Buffer.from(await upstream.arrayBuffer());
      if (buffer.length > 5 * 1024 * 1024) {
        return res.status(413).json({ error: 'remote file too large' });
      }
      res.json({
        content_type: upstream.headers.get('content-type'),
        base64: buffer.toString('base64'),
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // 当前用户资料：完善昵称/头像（授权登录后资料不完整时由小程序引导填写）
  app.put('/api/users/me', (req, res) => {
    const { nickname, avatar_url } = req.body || {};
    const hasNickname = nickname !== undefined;
    const hasAvatar = avatar_url !== undefined;
    if (!hasNickname && !hasAvatar) {
      return res.status(400).json({ error: 'nickname or avatar_url is required' });
    }

    const sets = [];
    const params = [];
    if (hasNickname) {
      if (typeof nickname !== 'string' || !nickname.trim()) {
        return res.status(400).json({ error: 'nickname must be a non-empty string' });
      }
      if (nickname.trim().length > NICKNAME_MAX_LEN) {
        return res
          .status(400)
          .json({ error: `nickname too long (max ${NICKNAME_MAX_LEN} characters)` });
      }
      sets.push('nickname = ?');
      params.push(nickname.trim());
    }
    if (hasAvatar) {
      if (typeof avatar_url !== 'string' || avatar_url.length > AVATAR_URL_MAX_LEN) {
        return res.status(400).json({ error: 'avatar_url must be a string (max 500 chars)' });
      }
      if (avatar_url && !/^(\/uploads\/|https?:\/\/)/.test(avatar_url)) {
        return res.status(400).json({ error: 'avatar_url must be a /uploads/ path or http(s) URL' });
      }
      sets.push('avatar_url = ?');
      params.push(avatar_url);
    }

    params.push(req.user.id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ user, profile_completed: isProfileComplete(user) });
  });

  // 用户主页
  app.get('/api/users/:id', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'user not found' });
    res.json({ user });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    console.error(err);
    res.status(500).json({
      error: 'internal server error',
      message: err.message,
      stack: err.stack,
    });
  });

  return app;
}

module.exports = { createApp };
