const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, api, login } = require('./helpers');

// 固定 openid 的微信替身：同一 openid 可对应多个 code（模拟用户多次 wx.login）
const OPENID_BY_CODE = { c1: 'openid_u1', c2: 'openid_u1', c3: 'openid_u2' };
const wechatStub = {
  async code2Session(code) {
    if (code === 'rejected') {
      const err = new Error('微信登录失败(40013): invalid code');
      err.wechatError = true;
      throw err;
    }
    return { openid: OPENID_BY_CODE[code] || `openid_${code}`, session_key: 'sk' };
  },
};

const wechatLogin = (base, body) =>
  api(base, { method: 'POST', path: '/api/auth/wechat-login', body });

test('微信授权登录：新用户建档，昵称为空 → profile_completed=false', async (t) => {
  const { server, base } = await startServer({ wechat: wechatStub });
  t.after(() => server.close());

  const res = await wechatLogin(base, { code: 'c1' });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(res.body.user.openid, 'openid_u1');
  assert.equal(res.body.user.nickname, '');
  assert.equal(res.body.profile_completed, false);
});

test('微信授权登录：同一 openid 再次登录复用同一用户（不重复建档）', async (t) => {
  const { server, base, db } = await startServer({ wechat: wechatStub });
  t.after(() => server.close());

  const first = await wechatLogin(base, { code: 'c1' });
  const second = await wechatLogin(base, { code: 'c2' }); // 同 openid，不同 code
  assert.equal(second.status, 201);
  assert.equal(second.body.user.id, first.body.user.id);

  // 库里只有一个用户，且 token 可正常访问业务接口
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  const products = await api(base, { path: '/api/products', token: second.body.token });
  assert.equal(products.status, 200);
});

test('微信授权登录：参数与微信侧错误处理', async (t) => {
  const { server, base } = await startServer({ wechat: wechatStub });
  t.after(() => server.close());

  const noCode = await wechatLogin(base, {});
  assert.equal(noCode.status, 400);
  assert.match(noCode.body.error, /code/);

  const rejected = await wechatLogin(base, { code: 'rejected' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /微信登录失败/);

  // 非微信错误的异常 → 502
  const boom = await startServer({
    wechat: {
      async code2Session() {
        throw new Error('network down');
      },
    },
  });
  t.after(() => boom.server.close());
  const net = await wechatLogin(boom.base, { code: 'c1' });
  assert.equal(net.status, 502);
});

test('PUT /api/users/me：补全昵称+头像后资料变完整，同 openid 再登录直接通过', async (t) => {
  const { server, base } = await startServer({ wechat: wechatStub });
  t.after(() => server.close());

  const { token } = (await wechatLogin(base, { code: 'c1' })).body;

  // 未登录 → 401
  const noAuth = await api(base, { method: 'PUT', path: '/api/users/me', body: { nickname: 'x' } });
  assert.equal(noAuth.status, 401);

  // 空 body → 400
  const empty = await api(base, { method: 'PUT', path: '/api/users/me', token, body: {} });
  assert.equal(empty.status, 400);

  // 昵称为空串 / 超长 → 400
  const blank = await api(base, { method: 'PUT', path: '/api/users/me', token, body: { nickname: '  ' } });
  assert.equal(blank.status, 400);
  const tooLong = await api(base, {
    method: 'PUT',
    path: '/api/users/me',
    token,
    body: { nickname: 'a'.repeat(21) },
  });
  assert.equal(tooLong.status, 400);

  // avatar_url 必须是 /uploads/ 或 http(s)
  const badAvatar = await api(base, {
    method: 'PUT',
    path: '/api/users/me',
    token,
    body: { nickname: '小明', avatar_url: 'javascript:alert(1)' },
  });
  assert.equal(badAvatar.status, 400);

  // 正常补全（昵称去首尾空格）
  const ok = await api(base, {
    method: 'PUT',
    path: '/api/users/me',
    token,
    body: { nickname: '  小明  ', avatar_url: '/uploads/abc.png' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.nickname, '小明');
  assert.equal(ok.body.user.avatar_url, '/uploads/abc.png');
  assert.equal(ok.body.profile_completed, true);

  // 同一 openid 重新授权登录 → 直接判定资料完整
  const again = await wechatLogin(base, { code: 'c2' });
  assert.equal(again.body.user.id, ok.body.user.id);
  assert.equal(again.body.profile_completed, true);

  // 之后可用 token 正常访问业务接口
  const groups = await api(base, { path: '/api/groups', token: again.body.token });
  assert.equal(groups.status, 200);
});

test('PUT /api/users/me：不同用户的资料互不影响', async (t) => {
  const { server, base, db } = await startServer({ wechat: wechatStub });
  t.after(() => server.close());

  const u1 = (await wechatLogin(base, { code: 'c1' })).body;
  const u2 = (await wechatLogin(base, { code: 'c3' })).body;
  assert.notEqual(u1.user.id, u2.user.id);

  await api(base, { method: 'PUT', path: '/api/users/me', token: u1.token, body: { nickname: '甲' } });

  const other = await api(base, {
    method: 'PUT',
    path: '/api/users/me',
    token: u2.token,
    body: { nickname: '乙', avatar_url: 'https://example.com/a.png' },
  });
  assert.equal(other.status, 200);
  assert.equal(other.body.user.nickname, '乙');

  // u1 的资料未被 u2 的修改污染
  const u1Row = db.prepare('SELECT * FROM users WHERE id = ?').get(u1.user.id);
  assert.equal(u1Row.nickname, '甲');
  assert.equal(u1Row.avatar_url, '');
});

test('mock-login 回归：仍然可用且资料完整', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const res = await login(base, '老用户');
  assert.ok(res.token);
  assert.equal(res.user.nickname, '老用户');
  assert.equal(res.user.nickname.trim() !== '', true);
});
